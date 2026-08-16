/**
 * Builtin-skill → SDK-plugin wrapper
 *
 * The Claude Agent SDK's `plugins: [{ type: 'local', path }]` option requires
 * each plugin path to be a proper plugin directory — one containing either
 * `.claude-plugin/plugin.json` or `.claude-plugin/marketplace.json`, with
 * slash commands / skills living under `commands/`, `skills/<name>/SKILL.md`,
 * etc. (When neither manifest exists the SDK logs "No manifest found" and
 * silently skips the entry, which is why `/playwright` used to return
 * "Unknown command".)
 *
 * Our builtin skills, however, ship in the shape established by Anthropic's
 * agent-skills repo: `~/.hyperneo/skills/<commandName>/SKILL.md` plus any
 * sibling assets. That's a skill directory, not a plugin directory. Pointing
 * the SDK at it directly fails.
 *
 * This module bridges the two conventions by generating a small wrapper
 * plugin for each builtin skill at a separate location:
 *
 *   ~/.hyperneo/skill-plugins/<commandName>/
 *   ├── .claude-plugin/plugin.json
 *   └── skills/<commandName>/    → symlink to ~/.hyperneo/skills/<commandName>/
 *
 * The SDK plugin loader then discovers `skills/<commandName>/SKILL.md` via
 * the wrapper and exposes `/<commandName>` as a slash command. We keep the
 * user-visible skill directory (`~/.hyperneo/skills/<commandName>`) exactly
 * where it has always been so that manual edits still work.
 *
 * Wrapper generation is idempotent: the plugin.json is rewritten on every
 * call (cheap), and the symlink is only replaced when its target drifts.
 * When the platform refuses symlinks (e.g. Windows without developer mode)
 * we fall back to mirroring the skill directory contents by recursive copy
 * so the wrapper still resolves.
 */

import { getDataDir } from '../data-dir';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@hyperneo/shared';

const log = createLogger('hyperneo:daemon:builtin-skill-plugin-wrapper');

/**
 * Default root directory where wrapper plugin directories are materialised.
 * Keeping this separate from `~/.hyperneo/skills/` means regenerating wrappers
 * never touches user-edited skill content.
 */
export function defaultBuiltinSkillPluginRoot(): string {
  return join(getDataDir(), 'skill-plugins');
}

/**
 * Resolve the wrapper plugin directory for a builtin skill.
 * Callers use the returned path as the `plugins[].path` entry passed to the SDK.
 */
export function builtinSkillPluginPath(wrappersRoot: string, commandName: string): string {
  return join(wrappersRoot, commandName);
}

export interface BuiltinSkillPluginWrapperOptions {
  /** Optional description — copied into plugin.json.description when provided. */
  description?: string;
  /** Optional version string — copied into plugin.json.version when provided. Defaults to "0.0.0". */
  version?: string;
}

/**
 * Ensure a wrapper plugin exists for a single builtin skill and return its
 * absolute path. Safe to call repeatedly — see module doc for details.
 *
 * When the source skill directory does not exist yet, the wrapper is created
 * as an empty shell (plugin.json + empty `skills/<name>/`) so a later sync
 * step populating the skill will still resolve via the symlink.
 */
export async function ensureBuiltinSkillPluginWrapper(
  wrappersRoot: string,
  skillsRoot: string,
  commandName: string,
  options: BuiltinSkillPluginWrapperOptions = {}
): Promise<string> {
  const wrapperDir = builtinSkillPluginPath(wrappersRoot, commandName);
  const pluginJsonDir = join(wrapperDir, '.claude-plugin');
  const pluginJsonPath = join(pluginJsonDir, 'plugin.json');
  const skillsSubdir = join(wrapperDir, 'skills');
  const skillLinkPath = join(skillsSubdir, commandName);
  const skillTarget = join(skillsRoot, commandName);

  await mkdir(pluginJsonDir, { recursive: true });
  await mkdir(skillsSubdir, { recursive: true });

  const manifest: Record<string, unknown> = {
    name: commandName,
    version: options.version ?? '0.0.0',
  };
  if (options.description !== undefined && options.description !== '') {
    manifest.description = options.description;
  }
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(pluginJsonPath, manifestJson, 'utf8');

  await linkSkillDirectory(skillLinkPath, skillTarget);

  return wrapperDir;
}

/**
 * Ensure wrappers for a set of builtin skills. Returns a map from commandName
 * to wrapper directory path. Errors on individual skills are logged but do
 * not abort the loop, so one bad skill cannot break daemon startup.
 */
export async function ensureBuiltinSkillPluginWrappers(
  wrappersRoot: string,
  skillsRoot: string,
  skills: Array<{ commandName: string } & BuiltinSkillPluginWrapperOptions>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const skill of skills) {
    try {
      const dir = await ensureBuiltinSkillPluginWrapper(
        wrappersRoot,
        skillsRoot,
        skill.commandName,
        { description: skill.description, version: skill.version }
      );
      result.set(skill.commandName, dir);
    } catch (err) {
      log.warn(
        `Failed to create plugin wrapper for builtin skill "${skill.commandName}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return result;
}

/**
 * Make `linkPath` resolve to the skill directory at `target`.
 *
 * Preferred strategy: a directory symlink. If the link already exists and
 * points at the same target, nothing is done. Otherwise any stale entry
 * (symlink with different target, real directory, or stray file) is removed
 * first.
 *
 * Fallback: when symlink creation fails because the platform disallows them
 * (EPERM / ENOSYS, seen on Windows without developer mode), we mirror the
 * target's contents into a regular directory. This is a worst-case path —
 * macOS and Linux always take the symlink branch.
 */
async function linkSkillDirectory(linkPath: string, target: string): Promise<void> {
  const existing = await tryLstat(linkPath);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const current = await tryReadlink(linkPath);
      if (current === target) return;
      await unlink(linkPath);
    } else if (existing.isDirectory()) {
      await rm(linkPath, { recursive: true, force: true });
    } else {
      await unlink(linkPath);
    }
  }

  try {
    await symlink(target, linkPath, 'dir');
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Another process beat us to it — accept whatever is there.
      return;
    }
    if (code !== 'EPERM' && code !== 'ENOSYS') throw err;
    log.warn(
      `symlink not permitted for ${linkPath} (code ${code}), falling back to directory copy`
    );
  }

  await mirrorDirectory(target, linkPath);
}

async function tryLstat(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function tryReadlink(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Recursively mirror `src` into `dest`. Only used as a fallback when symlinks
 * are unavailable; regular installs never execute this path.
 */
async function mirrorDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  let exists = true;
  try {
    await access(src);
  } catch {
    exists = false;
  }
  if (!exists) return;

  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mirrorDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve the link and copy its content — safer than re-creating a
      // symlink that might have been invalid at the source.
      try {
        const content = await readFile(srcPath);
        await writeFile(destPath, content);
      } catch {
        // Ignore broken links in the source tree.
      }
    }
  }
}
