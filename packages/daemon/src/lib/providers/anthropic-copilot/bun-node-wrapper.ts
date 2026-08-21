import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRunningUnderBun } from '../../agent/sdk-cli-resolver.js';

let bunSupportsNodeSqliteCache: boolean | undefined;

function bunSupportsNodeSqlite(): boolean {
  if (!isRunningUnderBun()) return false;
  if (bunSupportsNodeSqliteCache !== undefined) return bunSupportsNodeSqliteCache;
  try {
    execFileSync(
      process.execPath,
      ['-e', "import('node:sqlite').then(() => process.exit(0)).catch(() => process.exit(1))"],
      { stdio: 'ignore' }
    );
    bunSupportsNodeSqliteCache = true;
  } catch {
    bunSupportsNodeSqliteCache = false;
  }
  return bunSupportsNodeSqliteCache;
}

export function ensureBunNodeWrapper(): string | undefined {
  if (!isRunningUnderBun()) return undefined;
  const wrapperDir = join(tmpdir(), 'hyperneo-bun-node-wrapper');
  const nodePath = join(wrapperDir, 'node');
  const bunPath = process.execPath;
  try {
    mkdirSync(wrapperDir, { recursive: true });
    let needsSymlink = true;
    try {
      needsSymlink = readlinkSync(nodePath) !== bunPath;
    } catch {}
    if (needsSymlink) {
      try {
        unlinkSync(nodePath);
      } catch {}
      symlinkSync(bunPath, nodePath);
    }
    return wrapperDir;
  } catch {
    return undefined;
  }
}

export function buildCopilotEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!bunSupportsNodeSqlite()) return base;
  const wrapperDir = ensureBunNodeWrapper();
  if (!wrapperDir) return base;
  const existingPath = base.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return { ...base, PATH: `${wrapperDir}:${existingPath}` };
}
