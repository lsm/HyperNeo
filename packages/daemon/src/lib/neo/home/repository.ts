import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NeoRepository } from '../../../storage/repositories/neo-repository.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import { neoDerivedId } from '../derived-id.ts';
import { applyHomeChoice } from './apply-choice.ts';
import type { HomeConflict, HomeFailure } from './conflicts.ts';
import { homeRemoteUrl, type HomeReadInput, type HomeReadResult } from './read.ts';
import {
  requireHomePath,
  requireHomeSave,
  type HomeSavePlan,
  type HomeSaveResult,
} from './save.ts';

export type HomeResult =
  | { ok: true; path: string; projects: { id: string; homePath: string }[] }
  | { ok: false; reason: string };

type HomeSyncResult = { value: string | null } | { reason: HomeFailure };

const HOME_RUNTIME_DIRS = ['.coordinators', '.claude', 'worktrees'];

export class NeoHomeRepository {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    private readonly projects: NeoRepository,
    private readonly networkTimeoutMs = 30_000
  ) {}

  private async git(args: string[], allowFailure = false, network = false, cwd = this.root) {
    return this.command(
      ['git', '-c', 'core.hooksPath=/dev/null', ...args],
      allowFailure,
      network,
      cwd
    );
  }

  github(args: string[]) {
    return this.command(['gh', ...args], true, true);
  }

  private async command(args: string[], allowFailure = false, network = false, cwd = this.root) {
    const child = spawnProcess(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      detached: network,
      env: network
        ? {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined
              )
            ),
            GIT_TERMINAL_PROMPT: '0',
            GH_PROMPT_DISABLED: '1',
            GIT_ASKPASS: '/usr/bin/false',
            SSH_ASKPASS: '/usr/bin/false',
            SSH_ASKPASS_REQUIRE: 'force',
            GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
          }
        : undefined,
    });
    let timedOut = false;
    const timer = network
      ? setTimeout(() => {
          timedOut = true;
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, this.networkTimeoutMs)
      : undefined;
    try {
      const [text, error, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const diagnostic = timedOut
        ? `network timed out after ${this.networkTimeoutMs}ms`
        : error.trim();
      if (code && !allowFailure) throw new Error(`home ${args.join(' ')}: ${diagnostic}`);
      const bytes = Buffer.from(text);
      return { code, bytes, text: bytes.toString('utf8').trim(), error: diagnostic };
    } finally {
      clearTimeout(timer);
    }
  }

  private async synchronize(): Promise<HomeSyncResult> {
    if ((await this.git(['remote', 'get-url', 'origin'], true)).code) return { value: null };
    const upstream = await this.git(['rev-parse', '--symbolic-full-name', '@{upstream}'], true);
    const prefix = 'refs/remotes/origin/';
    if (upstream.code || !upstream.text.startsWith(prefix))
      return {
        reason: {
          ok: false,
          reason: 'sync_failed: configure this branch to track origin before saving.',
        },
      };
    const branch = `refs/heads/${upstream.text.slice(prefix.length)}`;
    for (const state of ['rebase-merge', 'rebase-apply']) {
      const existing = await lstat(join(this.root, '.git', state)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (existing)
        return {
          reason: { ok: false, reason: 'sync_failed: finish the existing rebase before saving.' },
        };
    }
    const local = (await this.git(['rev-parse', 'HEAD'])).text;
    const fetched = await this.git(['fetch', 'origin', branch], true, true);
    if (fetched.code) return { reason: { ok: false, reason: `sync_failed: ${fetched.error}` } };
    const remote = (await this.git(['rev-parse', 'FETCH_HEAD'])).text;
    const staging = await mkdtemp(join(dirname(this.root), '.neo-home-sync-'));
    try {
      const added = await this.git(['worktree', 'add', '--detach', staging, local], true);
      if (added.code) return { reason: { ok: false, reason: `sync_failed: ${added.error}` } };
      const rebased = await this.git(['-C', staging, 'rebase', remote], true, true);
      const candidate = (await this.git(['-C', staging, 'rev-parse', 'HEAD'])).text;
      const diverged =
        !rebased.code &&
        (await this.git(['merge-base', '--is-ancestor', local, candidate], true)).code === 1;
      if (rebased.code || diverged) {
        let conflict: HomeConflict | undefined;
        const paths = (
          await this.git(
            diverged
              ? ['diff', '--name-only', '-z', local, remote]
              : ['-C', staging, 'diff', '--name-only', '--diff-filter=U', '-z']
          )
        ).bytes
          .toString('utf8')
          .split('\0')
          .filter(Boolean);
        if (paths.length || diverged) {
          const versions = await Promise.all(
            paths.map(async (path) => {
              const full = async (revision: string) => {
                const blob = await this.git(['show', `${revision}:${path}`], true);
                if (blob.code) return '(file absent)';
                const text = blob.bytes.toString('utf8');
                return Buffer.from(text, 'utf8').equals(blob.bytes)
                  ? text
                  : `Base64 bytes: ${blob.bytes.toString('base64')}`;
              };
              return `File: ${JSON.stringify(path)}\n\nLocal (${local})\n${await full(local)}\n\nRemote (${remote})\n${await full(remote)}`;
            })
          );
          const diff = (
            await this.git([
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--unified=2',
              local,
              remote,
              '--',
              ...paths,
            ])
          ).text;
          const lines = diff.split('\n');
          const excerpt = [
            ...lines.slice(0, 4),
            ...lines.filter((line) => line.startsWith('-')).slice(1, 4),
            ...lines.filter((line) => line.startsWith('+')).slice(1, 4),
          ]
            .map((line) => line.slice(0, 120))
            .join('\n');
          conflict = {
            id: neoDerivedId(JSON.stringify([this.root, local, remote])),
            text: `Home sync ${diverged ? 'history ' : ''}conflict: ${paths
              .map((path) => JSON.stringify(path))
              .join(', ')
              .slice(
                0,
                350
              )}\n\nLocal → remote (excerpt):\n\n${'`'.repeat(8)}diff\n${excerpt.slice(0, 1000).replaceAll('`', '\u02cb')}\n${'`'.repeat(8)}\n\nWhich version should we use? View full versions before choosing. Your answer records a choice; it does not apply a change by itself. Ask Neo to save the chosen version; protected documents require separate confirmation.`,
            document: versions.length
              ? versions.join('\n\n────────────────\n\n')
              : `Local (${local})\n\nRemote (${remote})\n\nNo document differences; the branch histories diverge. Review the preserved histories with the human before reconciling.`,
          };
        }
        return {
          reason: {
            ok: false,
            ...(conflict ? { conflict } : {}),
            reason: `${conflict ? 'conflict' : 'sync_failed'}: isolated rebase not applied; local files preserved. ${diverged ? 'Branch histories diverge; review the question before reconciling.' : rebased.error}`,
          },
        };
      }
      for (const state of ['rebase-merge', 'rebase-apply'])
        if (
          await lstat(join(this.root, '.git', state)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          })
        )
          return {
            reason: {
              ok: false,
              reason: 'sync_failed: a home rebase began during synchronization; no update applied.',
            },
          };
      const applied = await this.git(
        ['merge', '--ff-only', '--no-overwrite-ignore', '--no-autostash', candidate],
        true
      );
      return applied.code
        ? {
            reason: {
              ok: false,
              reason: `sync_failed: unsafe home update refused; no cleanup or rollback attempted. ${applied.error}`,
            },
          }
        : { value: branch };
    } finally {
      await this.git(['worktree', 'remove', '--force', staging], true);
      await rmdir(staging).catch((error) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
      });
    }
  }

  private sequence<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run);
    this.pending = result.catch(() => {});
    return result;
  }

  init(remoteUrl?: string): Promise<HomeResult> {
    return this.sequence(async () => {
      if (remoteUrl) {
        const cloned = await this.clone(remoteUrl);
        if (cloned) return cloned;
      }
      return this.initialize();
    });
  }

  private async clone(remoteUrl: string): Promise<{ ok: false; reason: string } | null> {
    await mkdir(this.root, { recursive: true });
    const existing = await readdir(this.root);
    if (existing.includes('.git')) {
      const origin = await this.git(['remote', 'get-url', 'origin'], true);
      if (origin.code)
        return {
          ok: false,
          reason:
            'local_home_exists: this local history has no origin. Keep it; clone into a fresh data directory, or have the human reconcile it with the shared remote before retrying.',
        };
      return origin.text === remoteUrl
        ? null
        : { ok: false, reason: 'remote_exists: keep the existing home and its origin.' };
    }
    if (existing.some((name) => name !== '.coordinators'))
      return {
        ok: false,
        reason: 'home_exists: choose an empty home; existing files are preserved.',
      };
    const staging = await mkdtemp(join(dirname(this.root), '.neo-clone-'));
    const created: { path: string; directory: boolean }[] = [];
    const publish = async (source: string, target: string): Promise<void> => {
      const entry = await lstat(source);
      if (entry.isDirectory()) {
        await mkdir(target);
        created.push({ path: target, directory: true });
        for (const name of await readdir(source))
          await publish(join(source, name), join(target, name));
      } else {
        if (entry.isSymbolicLink()) await symlink(await readlink(source), target);
        else await copyFile(source, target, constants.COPYFILE_EXCL);
        created.push({ path: target, directory: false });
      }
    };
    try {
      const cloned = await this.git(
        ['clone', '--no-hardlinks', '--', remoteUrl, staging],
        true,
        true
      );
      if (cloned.code) return { ok: false, reason: `clone_failed: ${cloned.error}` };
      if ((await this.git(['-C', staging, 'rev-parse', '--verify', 'HEAD'], true)).code)
        return {
          ok: false,
          reason: 'empty_remote: select a home with a committed default branch.',
        };
      const entries = await readdir(staging, { withFileTypes: true });
      if (entries.some((entry) => entry.name === '.coordinators'))
        return {
          ok: false,
          reason: 'private_transcripts: remove coordinator transcripts from the remote first.',
        };
      for (const entry of entries.sort(
        (a, b) => Number(a.name === '.git') - Number(b.name === '.git')
      )) {
        await publish(join(staging, entry.name), join(this.root, entry.name));
      }
      return null;
    } catch (error) {
      for (const entry of created.reverse())
        await (entry.directory ? rmdir(entry.path) : unlink(entry.path)).catch(() => {});
      return {
        ok: false,
        reason: `clone_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  createGithub(repository: string, reserve: () => boolean) {
    return this.sequence(async () => {
      const initialized = await this.initialize();
      if (!initialized.ok) return initialized;
      if (!(await this.git(['remote', 'get-url', 'origin'], true)).code)
        return { ok: false as const, reason: 'remote_exists: keep the configured origin.' };
      const publication = requireHomeSave({
        path: 'home',
        message: 'Publish home',
        content: (
          await this.git(['log', '--format=', '--patch', '--no-ext-diff', '--no-textconv', 'HEAD'])
        ).text,
      });
      if (publication.reason) return publication.reason;
      if (!reserve())
        return {
          ok: false as const,
          reason:
            'creation_unconfirmed: reconcile the prior attempt with the human; never replay creation.',
        };
      const result = await this.github([
        'repo',
        'create',
        repository,
        '--private',
        '--source',
        '.',
        '--remote',
        'origin',
        '--push',
      ]);
      return result.code
        ? {
            ok: false as const,
            reason: `creation_unconfirmed: check GitHub/origin with the human before any retry. ${result.error}`,
          }
        : { ok: true as const };
    });
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

  changedRevision(ref: string, revision: string | null): Promise<string | null> {
    return this.sequence(async () => {
      const path = ref.split('#')[0];
      if ('reason' in requireHomePath({ path }) || (await this.hasSymbolicLink(path))) return null;
      const metadata = await lstat(join(this.root, '.git')).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!metadata?.isDirectory()) return null;
      const current = await this.git(
        ['--literal-pathspecs', 'log', '-1', '--format=%H', 'HEAD', '--', path],
        true
      );
      if (current.code || !current.text || current.text === revision) return null;
      if (revision) {
        const [head, previous] = await Promise.all([
          this.git(['rev-parse', '--verify', '--end-of-options', `HEAD:${path}`], true),
          this.git(['rev-parse', '--verify', '--end-of-options', `${revision}:${path}`], true),
        ]);
        if (!head.code && !previous.code && head.text === previous.text) return null;
      }
      return current.text;
    });
  }

  read(input: HomeReadInput): Promise<HomeReadResult> {
    return this.sequence(() => this.readDocument(input.path, input.includeRemote));
  }

  private async readDocument(path: string, includeRemote = false): Promise<HomeReadResult> {
    if (await this.hasSymbolicLink(path))
      return { ok: false, reason: 'invalid_path: symbolic link.' };
    const metadata = await lstat(join(this.root, '.git')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!metadata) return { ok: false, reason: 'not_found: home is not initialized.' };
    if (!metadata.isDirectory()) return { ok: false, reason: 'invalid_path: home git directory.' };
    const synced = await this.synchronize();
    if ('reason' in synced) return synced.reason;
    if (await this.hasSymbolicLink(path))
      return { ok: false, reason: 'invalid_path: symbolic link.' };
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
    return {
      ok: true,
      path,
      content,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(includeRemote
        ? {
            remoteUrl: homeRemoteUrl(
              (await this.git(['config', '--get', 'remote.origin.url'], true)).text
            ),
          }
        : {}),
    };
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
    const publish = !!metadata && !(await this.git(['remote', 'get-url', 'origin'], true)).code;
    for (const content of [
      input.content,
      ...(input.confirmation ? [input.confirmation.entry] : []),
    ]) {
      const checked = requireHomeSave({ ...input, content }, publish);
      if (checked.reason) return checked.reason;
    }
    if (metadata)
      for (const path of paths)
        if (!(await this.git(['check-ignore', '-q', '--', path], true)).code)
          return {
            ok: false,
            reason: 'ignored_path: this document or decision log is git-ignored.',
          };
    if (input.resolution) {
      if (!metadata) return { ok: false, reason: 'not_found: the home repository is missing.' };
      return applyHomeChoice(this.root, input, (args, failure, network, cwd) =>
        this.git(args, failure, network, cwd)
      );
    }
    const initialized = await this.initialize();
    if (!initialized.ok) return initialized;
    const synced = await this.synchronize();
    if ('reason' in synced) return synced.reason;
    if (synced.value)
      for (const path of paths)
        if (await this.hasSymbolicLink(path))
          return { ok: false, reason: 'invalid_path: symbolic link.' };
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
    const commit = (await this.git(['rev-parse', 'HEAD'])).text;
    if (synced.value) {
      const publication = requireHomeSave({
        ...input,
        content: (
          await this.git([
            'log',
            '--format=',
            '--patch',
            '--no-ext-diff',
            '--no-textconv',
            `${synced.value.replace('refs/heads/', 'refs/remotes/origin/')}..HEAD`,
          ])
        ).text,
      });
      if (publication.reason) return publication.reason;
      const pushed = await this.git(['push', 'origin', `HEAD:${synced.value}`], true, true);
      if (pushed.code)
        return {
          ok: false,
          reason: `push_failed: local commit ${commit} is saved. ${pushed.error}`,
        };
    }
    return { ok: true, path: input.path, commit };
  }

  private async initialize(): Promise<HomeResult> {
    await mkdir(this.root, { recursive: true });
    await this.git(['init', '--quiet']);
    const hasHead = !(await this.git(['rev-parse', '--verify', 'HEAD'], true)).code;
    const ignores = (await this.git(['show', 'HEAD:.gitignore'], true)).text.split('\n');
    const paths = ['README.md', '.gitignore', 'direction.md'];
    if (!hasHead || !HOME_RUNTIME_DIRS.every((dir) => ignores.includes(`${dir}/`))) {
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
      const missing = HOME_RUNTIME_DIRS.filter((dir) => !ignore.split('\n').includes(`${dir}/`));
      if (missing.length)
        await writeFile(
          join(this.root, '.gitignore'),
          `${ignore}${!ignore || ignore.endsWith('\n') ? '' : '\n'}${missing.map((dir) => `${dir}/`).join('\n')}\n`
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
    const projects = await this.projects.reserveHomeProjects();
    for (const project of projects)
      await mkdir(join(this.root, project.homePath), { recursive: true });
    return { ok: true, path: this.root, projects };
  }
}
