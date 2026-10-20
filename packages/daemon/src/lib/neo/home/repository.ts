import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';

export type HomeResult =
  | {
      ok: true;
      path: string;
      content?: string;
      commit?: string;
      projects?: { id: string; homePath: string }[];
    }
  | { ok: false; reason: string };
export type HomeGate<T> = { value: T } | { reason: { ok: false; reason: string } };
const refused = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function requireHomePath(path: string): HomeGate<string> {
  return !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part.startsWith('.'))
    ? {
        reason: refused(
          'invalid_path: use a relative curated-document path, outside hidden folders.'
        ),
      }
    : { value: path };
}

export function requireHomeContent<T extends { path: string; content: string }>(
  input: T
): HomeGate<T> {
  if (input.path === 'direction.md' || /(^|\/)mandate\.md$/.test(input.path))
    return {
      reason: refused(
        'confirmation_required: direction and mandate saves require human confirmation (H2).'
      ),
    };
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+|xox[a-zA-Z0-9-]+|AKIA[A-Z0-9]+)|\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[^\s"']{16,}/i.test(
    input.content
  )
    ? {
        reason: refused(
          'secret_content: do not put keys, tokens or passwords in the home repository.'
        ),
      }
    : { value: input };
}

export class NeoHomeRepository {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private readonly projects: NeoRepository
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  private async git(args: string[], allowFailure = false): Promise<{ code: number; text: string }> {
    const child = spawnProcess(
      [
        'git',
        ...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']),
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: this.root,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [text, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code && (!allowFailure || (args[0] === 'check-ignore' && code !== 1)))
      throw new Error(`home git ${args[0]}: ${error.trim()}`);
    return { code, text: text.trim() };
  }

  private async safePath(path: string): Promise<boolean> {
    let current = this.root;
    for (const part of ['', ...path.split('/')]) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return true;
  }

  private async initialize(): Promise<HomeResult> {
    await mkdir(this.root, { recursive: true });
    if (!(await this.safePath('.git')))
      return refused('invalid_path: the home repo cannot use symlinks.');
    const metadata = await lstat(join(this.root, '.git')).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    if (metadata && !metadata.isDirectory())
      return refused('invalid_path: home git metadata must stay inside its own repository.');
    await this.git(['init', '--quiet']);
    const hasHead = !(await this.git(['rev-parse', '--verify', 'HEAD'], true)).code;
    const ignores = !(await this.git(['check-ignore', '-q', '--', '.coordinators/verify'], true))
      .code;
    if (!hasHead || !ignores) {
      if (hasHead && (await this.git(['status', '--porcelain', '--untracked-files=all'])).text)
        return refused('dirty: the home repository has changes outside the operation.');
      for (const [path, content] of [
        [
          'README.md',
          '# Neo home\n\nCurated direction and project documents. Activity stays in the daemon database.\n',
        ],
        ['direction.md', ''],
      ]) {
        if (!(await this.safePath(path)))
          return refused('invalid_path: the home repo cannot use symlinks.');
        try {
          await writeFile(join(this.root, path), content, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!(await this.safePath('.gitignore')))
        return refused('invalid_path: the home repo cannot use symlinks.');
      const previousIgnore = await readFile(join(this.root, '.gitignore'), 'utf8').catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return '';
        }
      );
      await writeFile(
        join(this.root, '.gitignore'),
        `${previousIgnore}${previousIgnore.endsWith('\n') || !previousIgnore ? '' : '\n'}.coordinators/\n`
      );
      for (const file of ['README.md', 'direction.md', '.gitignore']) {
        const content = await readFile(join(this.root, file), 'utf8');
        if (file === 'direction.md' && content.trim())
          return refused('confirmation_required: importing direction requires human confirmation.');
        const gate = requireHomeContent({ path: 'bootstrap.md', content });
        if ('reason' in gate) return gate.reason;
      }
      if ((await this.git(['diff', '--cached', '--name-only'])).text)
        return refused('dirty: staged changes must be reviewed by the human first.');
      await this.git(['add', '--', 'README.md', '.gitignore', 'direction.md']);
      await this.git([
        'commit',
        '--only',
        '-m',
        'Initialize Neo home',
        '--',
        'README.md',
        '.gitignore',
        'direction.md',
      ]);
    }
    const projects = this.projects
      .listProjects()
      .map((project) => ({ id: project.id, homePath: this.projects.ensureHomePath(project) }));
    for (const project of projects) {
      if ('reason' in requireHomePath(project.homePath) || !(await this.safePath(project.homePath)))
        return refused('invalid_path: unsafe project home path.');
      await mkdir(join(this.root, project.homePath), { recursive: true });
    }
    return { ok: true, path: this.root, projects };
  }

  init(): Promise<HomeResult> {
    return this.serial(() => this.initialize());
  }

  read(path: string): Promise<HomeResult> {
    return this.serial(async () => {
      if (!(await this.safePath(path)))
        return refused('invalid_path: symlinks are not home documents.');
      const metadata = await lstat(join(this.root, '.git')).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (!metadata?.isDirectory() || !(await this.safePath('.git')))
        return refused('not_initialized: initialize the Neo home repository first.');
      if (!(await this.git(['check-ignore', '-q', '--', path], true)).code)
        return refused('ignored: that path is private or git-ignored.');
      try {
        return { ok: true, path, content: await readFile(join(this.root, path), 'utf8') };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return refused('not_found: no such home document.');
      }
    });
  }

  save(input: { path: string; content: string; message: string }): Promise<HomeResult> {
    return this.serial(async () => {
      const initialized = await this.initialize();
      if (!initialized.ok) return initialized;
      if (!(await this.safePath(input.path)))
        return refused('invalid_path: symlinks are not home documents.');
      if (!(await this.git(['check-ignore', '-q', '--', input.path], true)).code)
        return refused('ignored: that path is private or git-ignored.');
      if ((await this.git(['status', '--porcelain', '--untracked-files=all'])).text)
        return refused('dirty: the home repository has changes outside the operation.');
      const file = join(this.root, input.path);
      const previous = await readFile(file, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (previous === input.content)
        return { ok: true, path: input.path, commit: (await this.git(['rev-parse', 'HEAD'])).text };
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(file, input.content);
        await this.git(['add', '--', input.path]);
        await this.git(['commit', '--only', '-m', input.message, '--', input.path]);
      } catch (error) {
        if (previous === null) await unlink(file);
        else await writeFile(file, previous);
        await this.git(['reset', '--', input.path], true);
        throw error;
      }
      return { ok: true, path: input.path, commit: (await this.git(['rev-parse', 'HEAD'])).text };
    });
  }
}
