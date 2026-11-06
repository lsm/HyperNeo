import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIPv6 } from 'node:net';
import { DatabaseLock } from '../storage/database-lock.ts';
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

export function dialableHost(bindHost: string): string {
  if (LOOPBACK_HOSTS.has(bindHost)) return '127.0.0.1';
  if (isIPv6(bindHost)) return `[${bindHost}]`;
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeDescriptor> | number;
    if (typeof parsed === 'number') return parsed;
    return typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

export function hasOtherRuntimeOwner(dataDir: string = getDataDir()): boolean {
  const path = descriptorFilePath(dataDir);
  return [readDescriptorPid(`${path}.owner.lock`), readDescriptorPid(path)].some(
    (pid) => pid !== undefined && pid !== process.pid && isProcessAlive(pid)
  );
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

  const lock = new DatabaseLock(`${path}.owner`);
  try {
    lock.acquire();
    if (hasOtherRuntimeOwner(dataDir)) {
      lock.release();
      return () => {};
    }
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.${process.pid}.staging`;
    writeFileSync(staging, `${JSON.stringify(descriptor)}\n`, 'utf8');
    renameSync(staging, path);
  } catch {
    lock.release();
    return () => {};
  }

  return () => {
    removeRuntimeDescriptor(path, process.pid);
    lock.release();
  };
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
