import { Buffer } from 'node:buffer';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import type { HomeSaveInput, HomeSaveResult } from './save.ts';

export type HomeResult =
  | { ok: true; path: string; projects: { id: string; homePath: string }[] }
  | { ok: false; reason: string };

export class NeoHomeRepository {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private readonly projects: NeoRepository
  ) {}

  private async git(args: string[], allowFailure = false) {
    const child = spawnProcess(['git', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: this.root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code && !allowFailure) throw new Error(`home git ${args[0]}: ${error.trim()}`);
    return { code, text: text.trim() };
  }

  private sequence<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run);
    this.pending = result.catch(() => {});
    return result;
  }

  init(): Promise<HomeResult> {
    return this.sequence(() => this.initialize());
  }

  save(input: HomeSaveInput): Promise<HomeSaveResult> {
    return this.sequence(() => this.write(input));
  }

  private async write(input: HomeSaveInput): Promise<HomeSaveResult> {
    const parts = input.path.split('/');
    for (let i = 0; i <= parts.length; i++) {
      const stat = await lstat(join(this.root, ...parts.slice(0, i))).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (stat?.isSymbolicLink()) return { ok: false, reason: 'invalid_path: symbolic link.' };
    }
    const metadata = await lstat(join(this.root, '.git')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (metadata && !metadata.isDirectory())
      return { ok: false, reason: 'invalid_path: home git directory.' };
    const dirty = metadata
      ? (await this.git(['status', '--porcelain', '--untracked-files=all'])).text
      : (
          await readdir(this.root).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return [];
          })
        ).some((name) => name !== '.coordinators');
    if (dirty) return { ok: false, reason: 'dirty: review existing home changes before saving.' };
    const initialized = await this.initialize();
    if (!initialized.ok) return initialized;
    if (!(await this.git(['check-ignore', '-q', '--', input.path], true)).code)
      return { ok: false, reason: 'ignored_path: this document is git-ignored.' };
    const path = join(this.root, input.path);
    const before = await readFile(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const content = Buffer.from(input.content, 'utf8');
    if (!before?.equals(content)) {
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, content);
        await this.git(['add', '--', input.path]);
        await this.git(['commit', '--only', '-m', input.message, '--', input.path]);
      } catch (error) {
        await this.git(['reset', '--', input.path]).catch(() => {});
        await (before === null ? rm(path, { force: true }) : writeFile(path, before)).catch(
          () => {}
        );
        throw error;
      }
    }
    return { ok: true, path: input.path, commit: (await this.git(['rev-parse', 'HEAD'])).text };
  }

  private async initialize(): Promise<HomeResult> {
    await mkdir(this.root, { recursive: true });
    await this.git(['init', '--quiet']);
    const hasHead = !(await this.git(['rev-parse', '--verify', 'HEAD'], true)).code;
    const ignores = (await this.git(['show', 'HEAD:.gitignore'], true)).text
      .split('\n')
      .includes('.coordinators/');
    const paths = ['README.md', '.gitignore', 'direction.md'];
    if (!hasHead || !ignores) {
      const changes = (
        await this.git(
          hasHead
            ? ['status', '--porcelain', '-z', '--untracked-files=all']
            : ['diff', '--cached', '--name-only', '-z']
        )
      ).text
        .split('\0')
        .filter((entry) => entry && !(hasHead && entry.startsWith('?? .coordinators/')));
      const interrupted =
        !hasHead &&
        changes.length === paths.length &&
        paths.every((path) => changes.includes(path));
      if (changes.length && !interrupted)
        return { ok: false, reason: 'dirty: review existing home changes before initialization.' };
      const documents = new Map([
        [
          'README.md',
          '# Neo home\n\nCurated direction and project documents. Activity stays in the daemon database.\n',
        ],
        ['direction.md', ''],
      ]);
      const created: string[] = [];
      for (const [path, content] of documents) {
        try {
          await writeFile(join(this.root, path), content, { flag: 'wx' });
          created.push(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const originalIgnore = await readFile(join(this.root, '.gitignore'), 'utf8').catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return null;
        }
      );
      const ignore = originalIgnore ?? '';
      if (!ignore.split('\n').includes('.coordinators/'))
        await writeFile(
          join(this.root, '.gitignore'),
          `${ignore}${!ignore || ignore.endsWith('\n') ? '' : '\n'}.coordinators/\n`
        );
      try {
        await this.git(['add', '--', ...paths]);
        await this.git(['commit', '--only', '-m', 'Initialize Neo home', '--', ...paths]);
      } catch (error) {
        await this.git(['reset', '--', ...paths]).catch(() => {});
        if (hasHead) {
          for (const path of created)
            await rm(join(this.root, path), { force: true }).catch(() => {});
          await (originalIgnore === null
            ? rm(join(this.root, '.gitignore'), { force: true })
            : writeFile(join(this.root, '.gitignore'), originalIgnore)
          ).catch(() => {});
        }
        throw error;
      }
    }
    const projects = this.projects.listProjects().map((project) => ({
      id: project.id,
      homePath: this.projects.ensureHomePath(project),
    }));
    for (const project of projects)
      await mkdir(join(this.root, project.homePath), { recursive: true });
    return { ok: true, path: this.root, projects };
  }
}
