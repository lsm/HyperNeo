import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import type { HomeReadInput, HomeReadResult } from './read.ts';
import type { HomeSavePlan, HomeSaveResult } from './save.ts';

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

  save(input: HomeSavePlan): Promise<HomeSaveResult> {
    return this.sequence(() => this.write(input));
  }

  private async hasSymbolicLink(path: string): Promise<boolean> {
    const parts = path.split('/');
    for (let i = 0; i <= parts.length; i++) {
      const stat = await lstat(join(this.root, ...parts.slice(0, i))).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (stat?.isSymbolicLink()) return true;
    }
    return false;
  }

  read(input: HomeReadInput): Promise<HomeReadResult> {
    return this.sequence(() => this.readDocument(input.path));
  }

  private async readDocument(path: string): Promise<HomeReadResult> {
    if (await this.hasSymbolicLink(path))
      return { ok: false, reason: 'invalid_path: symbolic link.' };
    const metadata = await lstat(join(this.root, '.git')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!metadata) return { ok: false, reason: 'not_found: home is not initialized.' };
    if (!metadata.isDirectory()) return { ok: false, reason: 'invalid_path: home git directory.' };
    if (!(await this.git(['check-ignore', '-q', '--', path], true)).code)
      return { ok: false, reason: 'ignored_path: this document is git-ignored.' };
    const target = join(this.root, path);
    const stat = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!stat) return { ok: false, reason: 'not_found: home document does not exist.' };
    if (!stat.isFile()) return { ok: false, reason: 'not_file: choose a regular home document.' };
    const bytes = await readFile(target);
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes))
      return { ok: false, reason: 'invalid_content: home document is not UTF-8 text.' };
    return { ok: true, path, content, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  private async write(input: HomeSavePlan): Promise<HomeSaveResult> {
    const paths = [input.path];
    if (input.confirmation) paths.push(join(dirname(input.path), 'decisions.md'));
    for (const path of paths)
      if (await this.hasSymbolicLink(path))
        return { ok: false, reason: 'invalid_path: symbolic link.' };
    const metadata = await lstat(join(this.root, '.git')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (metadata && !metadata.isDirectory())
      return { ok: false, reason: 'invalid_path: home git directory.' };
    const dirty = metadata
      ? (await this.git(['status', '--porcelain', '-z', '--untracked-files=all'])).text
          .split('\0')
          .some((entry) => entry && !entry.startsWith('?? .coordinators/'))
      : (
          await readdir(this.root).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return [];
          })
        ).some((name) => name !== '.coordinators');
    if (dirty) return { ok: false, reason: 'dirty: review existing home changes before saving.' };
    const initialized = await this.initialize();
    if (!initialized.ok) return initialized;
    const originals = new Map<string, Buffer | null>();
    for (const path of paths) {
      if (!(await this.git(['check-ignore', '-q', '--', path], true)).code)
        return { ok: false, reason: 'ignored_path: this document is git-ignored.' };
      originals.set(
        path,
        await readFile(join(this.root, path)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        })
      );
    }
    const content = Buffer.from(input.content, 'utf8');
    if (!originals.get(input.path)?.equals(content)) {
      const writes = new Map([[input.path, content]]);
      if (input.confirmation)
        writes.set(
          paths[1],
          Buffer.concat([
            originals.get(paths[1]) ?? Buffer.alloc(0),
            Buffer.from(input.confirmation.entry, 'utf8'),
          ])
        );
      const message = input.confirmation
        ? `${input.message}\n\nNeo-Confirmed-By: question ${input.confirmation.questionId}`
        : input.message;
      try {
        for (const [path, bytes] of writes) {
          await mkdir(dirname(join(this.root, path)), { recursive: true });
          await writeFile(join(this.root, path), bytes);
        }
        await this.git(['add', '--', ...paths]);
        await this.git(['commit', '--only', '-m', message, '--', ...paths]);
      } catch (error) {
        await this.git(['reset', '--', ...paths]).catch(() => {});
        for (const [path, before] of originals)
          await (before === null
            ? rm(join(this.root, path), { force: true })
            : writeFile(join(this.root, path), before)
          ).catch(() => {});
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
