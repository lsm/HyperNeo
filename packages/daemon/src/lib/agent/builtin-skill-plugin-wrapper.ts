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

const log = createLogger('hyperneo:daemon:builtin-skill-plugin-wrapper', {
  consoleDeltas: true,
});

export function defaultBuiltinSkillPluginRoot(): string {
  return join(getDataDir(), 'skill-plugins');
}

export function builtinSkillPluginPath(wrappersRoot: string, commandName: string): string {
  return join(wrappersRoot, commandName);
}

export interface BuiltinSkillPluginWrapperOptions {
  description?: string;
  version?: string;
}

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
      try {
        const content = await readFile(srcPath);
        await writeFile(destPath, content);
      } catch {}
    }
  }
}
