import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILD_METADATA } from './build-metadata.ts';
import { getDataDir } from './data-dir.ts';

export interface RuntimeDescriptor {
  pid: number;
  host: string;
  port: number;
  url: string;
  version: string;
  startedAt: number;
}

const LOOPBACK_HOSTS = new Set(['0.0.0.0', '::', '::0', '']);

function dialableHost(bindHost: string): string {
  if (LOOPBACK_HOSTS.has(bindHost)) return '127.0.0.1';
  if (bindHost === '::1') return '[::1]';
  return bindHost;
}

function descriptorFilePath(dataDir: string): string {
  return join(dataDir, 'runtime.json');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readDescriptorPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeDescriptor>;
    return typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

export function writeRuntimeDescriptor(
  bindHost: string,
  port: number,
  dataDir: string = getDataDir()
): () => void {
  const path = descriptorFilePath(dataDir);
  const host = dialableHost(bindHost);
  const descriptor: RuntimeDescriptor = {
    pid: process.pid,
    host,
    port,
    url: `http://${host}:${port}`,
    version: BUILD_METADATA.version,
    startedAt: Date.now(),
  };

  const existingPid = readDescriptorPid(path);
  if (existingPid !== undefined && existingPid !== process.pid && isProcessAlive(existingPid)) {
    return () => {};
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.${process.pid}.staging`;
    writeFileSync(staging, `${JSON.stringify(descriptor)}\n`, 'utf8');
    renameSync(staging, path);
  } catch {
    return () => {};
  }

  return () => removeRuntimeDescriptor(path, process.pid);
}

function removeRuntimeDescriptor(path: string, pid: number): void {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeDescriptor>;
    if (typeof parsed.pid === 'number' && parsed.pid !== pid) return;
  } catch {}
  try {
    rmSync(path, { force: true });
  } catch {}
}
