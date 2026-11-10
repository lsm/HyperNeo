import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ApiSurface } from './api-diff.ts';

const root = resolve(import.meta.dir, '..');
function git(...args: string[]): Buffer {
  const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout;
}
function reuseDependencies(source: string): void {
  for (const relative of [
    '.',
    ...readdirSync(join(root, 'packages')).map((name) => `packages/${name}`),
  ]) {
    const from = join(root, relative, 'node_modules');
    let names: string[];
    try {
      names = readdirSync(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const to = join(source, relative, 'node_modules');
    mkdirSync(to, { recursive: true });
    for (const name of names) {
      if (name === '@hyperneo') {
        mkdirSync(join(to, name), { recursive: true });
        for (const workspace of readdirSync(join(source, 'packages')))
          symlinkSync(join(source, 'packages', workspace), join(to, name, workspace), 'dir');
      } else symlinkSync(realpathSync(join(from, name)), join(to, name), 'dir');
    }
  }
}
export async function surfaceAtRef(
  ref: string,
  worktreeRoot = tmpdir()
): Promise<{
  ref: string;
  commit: string;
  surface: ApiSurface;
  collected: boolean;
  sha256: string;
}> {
  const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
    .toString()
    .trim();
  let serialized: string,
    collected = false;
  const stored = Bun.spawnSync(['git', '-C', root, 'show', `${commit}:api-surface.json`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stored.exitCode === 0) serialized = stored.stdout.toString();
  else {
    const source = mkdtempSync(join(resolve(worktreeRoot), 'hyperneo-api-history-'));
    let registered = false;
    try {
      git('worktree', 'add', '--detach', source, commit);
      registered = true;
      const packageInfo = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (packageInfo.packageManager !== current.packageManager)
        throw new Error(
          'Historical release requires a different package manager; collect its snapshot with that pinned runtime first'
        );
      const dependency = (folder: string) =>
        JSON.parse(readFileSync(join(folder, 'packages/daemon/package.json'), 'utf8')).dependencies
          .zod;
      if (dependency(source) !== dependency(root))
        throw new Error(
          'Historical release requires a different Zod version; matching dependencies are required for faithful schema collection'
        );
      reuseDependencies(source);
      console.error(
        `Collecting historical API from ${ref} (${commit}) in an isolated detached worktree.`
      );
      const { generateApiSurface } = await import('./api-surface.ts');
      serialized = await generateApiSurface(source);
      collected = true;
    } finally {
      if (registered) git('worktree', 'remove', source);
      else rmSync(source, { recursive: true, force: true });
    }
  }
  const surface = JSON.parse(serialized) as ApiSurface;
  if (!Array.isArray(surface.operations) || !Array.isArray(surface.events))
    throw new Error(`Invalid API surface at ${ref}`);
  return {
    ref,
    commit,
    surface,
    collected,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}
