import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const DIR_PATTERN = /^hyperneo-settings-(\d+)-/;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removeAbandonedDirs(root: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(DIR_PATTERN.exec(entry)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

export function buildFlagSettings(
  options: Pick<Options, 'settings' | 'sandbox'>
): Record<string, unknown> | null {
  const { settings, sandbox } = options;
  if (!settings || typeof settings !== 'object' || !settings.env) return null;
  if (!sandbox) return settings;
  return {
    ...settings,
    sandbox:
      sandbox.enabled === true && sandbox.failIfUnavailable === undefined
        ? { ...sandbox, failIfUnavailable: true }
        : sandbox,
  };
}

export function createFlagSettingsFileWriter(root: string = tmpdir()) {
  let dir: string | undefined;
  return (options: Options, sessionId: string): (() => void) | undefined => {
    const content = buildFlagSettings(options);
    if (!content) return undefined;
    if (!dir) {
      removeAbandonedDirs(root);
      dir = mkdtempSync(join(root, `hyperneo-settings-${process.pid}-`));
    }
    const path = join(dir, `${sessionId.replace(/[^\w-]/g, '_')}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
    options.settings = path;
    delete options.sandbox;
    return () => rmSync(path, { force: true });
  };
}
