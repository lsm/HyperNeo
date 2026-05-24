/**
 * Bun → Node.js wrapper for CopilotClient subprocess.
 *
 * @github/copilot-sdk resolves its CLI executable as "node" when running
 * under Bun. We can optionally prepend a temp directory containing a `node`
 * symlink to Bun (process.execPath), so the Copilot CLI subprocess runs under
 * Bun instead of system Node.
 *
 * Important: this only works when the current Bun build supports `node:sqlite`.
 * If Bun lacks that built-in module, forcing the subprocess onto Bun causes
 * startup failure and downstream online-test timeouts. In that case we leave
 * PATH unchanged so system Node (>=22.5) is used.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRunningUnderBun } from '../../agent/sdk-cli-resolver.js';

let bunSupportsNodeSqliteCache: boolean | undefined;

/**
 * Returns true when the current Bun binary can import `node:sqlite`.
 *
 * We probe once by spawning `process.execPath` with a tiny script and cache
 * the result for the process lifetime.
 */
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

/**
 * Ensure a temp directory exists that contains a `node` symlink pointing to
 * the Bun binary (process.execPath).
 */
export function ensureBunNodeWrapper(): string | undefined {
  if (!isRunningUnderBun()) return undefined;
  const wrapperDir = join(tmpdir(), 'neokai-bun-node-wrapper');
  const nodePath = join(wrapperDir, 'node');
  const bunPath = process.execPath;
  try {
    mkdirSync(wrapperDir, { recursive: true });
    let needsSymlink = true;
    try {
      needsSymlink = readlinkSync(nodePath) !== bunPath;
    } catch {
      // Symlink does not exist yet — needs to be created.
    }
    if (needsSymlink) {
      try {
        unlinkSync(nodePath);
      } catch {
        // Ignore — may not exist.
      }
      symlinkSync(bunPath, nodePath);
    }
    return wrapperDir;
  } catch {
    return undefined;
  }
}

/**
 * Build env for CopilotClient subprocesses.
 *
 * If running under Bun and Bun supports `node:sqlite`, prepend the wrapper dir
 * so Copilot's internal `node` resolution points to Bun. Otherwise leave PATH
 * unchanged and rely on system Node.
 */
export function buildCopilotEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!bunSupportsNodeSqlite()) return base;
  const wrapperDir = ensureBunNodeWrapper();
  if (!wrapperDir) return base;
  const existingPath = base.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return { ...base, PATH: `${wrapperDir}:${existingPath}` };
}
