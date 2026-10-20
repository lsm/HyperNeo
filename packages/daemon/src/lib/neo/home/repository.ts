import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';

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

  init(): Promise<HomeResult> {
    const result = this.pending.then(() => this.initialize());
    this.pending = result.catch(() => {});
    return result;
  }

  private async initialize(): Promise<HomeResult> {
    await mkdir(this.root, { recursive: true });
    await this.git(['init', '--quiet']);
    const hasHead = !(await this.git(['rev-parse', '--verify', 'HEAD'], true)).code;
    const ignores = !(await this.git(['check-ignore', '-q', '--', '.coordinators/verify'], true))
      .code;
    if (!hasHead || !ignores) {
      if (
        (
          await this.git(
            hasHead
              ? ['status', '--porcelain', '--untracked-files=all']
              : ['diff', '--cached', '--name-only']
          )
        ).text
      )
        return { ok: false, reason: 'dirty: review existing home changes before initialization.' };
      const documents = new Map([
        [
          'README.md',
          '# Neo home\n\nCurated direction and project documents. Activity stays in the daemon database.\n',
        ],
        ['direction.md', ''],
      ]);
      for (const [path, content] of documents) {
        try {
          await writeFile(join(this.root, path), content, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const ignore = await readFile(join(this.root, '.gitignore'), 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return '';
      });
      if (!ignore.split('\n').includes('.coordinators/'))
        await writeFile(
          join(this.root, '.gitignore'),
          `${ignore}${!ignore || ignore.endsWith('\n') ? '' : '\n'}.coordinators/\n`
        );
      const paths = ['README.md', '.gitignore', 'direction.md'];
      await this.git(['add', '--', ...paths]);
      try {
        await this.git(['commit', '--only', '-m', 'Initialize Neo home', '--', ...paths]);
      } catch (error) {
        await this.git(['reset', '--', ...paths]).catch(() => {});
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
