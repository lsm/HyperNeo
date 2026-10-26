import type { Stats } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { DatabaseLock } from '../../storage/database-lock.ts';
import { ClaudeDesktopOutboxRepository } from '../../storage/repositories/claude-desktop-outbox-repository.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { createClaudeDesktopModsServer } from './claude-desktop-mods-server.ts';

type ServerDeps = Parameters<typeof createClaudeDesktopModsServer>[0];
interface Deps {
  db: Database;
  env: Record<string, string | undefined>;
  registrationsDir: string;
  liveSessions: ServerDeps['liveSessions'];
  onError: ServerDeps['onError'];
  onExchange?(sessionId: string): Promise<void>;
  socketDirectory?: string;
}
const activeFiles = new Set<string>();
function configuration(env: Deps['env']) {
  if (env.HYPERNEO_CLAUDE_DESKTOP_MODS !== '1') return { reason: undefined };
  const file = env.HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE;
  if (!file || !isAbsolute(file))
    throw new Error(
      'Desktop mods requires an absolute HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE'
    );
  return { value: file };
}
function privateFile(info: Stats) {
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error('Desktop mods connection directory/file must be private and owned');
}
async function startRuntime(file: string, deps: Deps) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(file));
  privateFile(parent);
  if (!parent.isDirectory()) throw new Error('Desktop mods connection parent must be a directory');
  file = join(await realpath(dirname(file)), basename(file));
  if (activeFiles.has(file)) throw new Error('Desktop mods connection file is already active');
  activeFiles.add(file);
  const lock = new DatabaseLock(`${file}.owner`);
  const outbox = new ClaudeDesktopOutboxRepository(deps.db);
  const listeners = new Set<(sessionId: string) => void>();
  const seen = new Map<string, { pid: number; at: number }>();
  let server: Awaited<ReturnType<typeof createClaudeDesktopModsServer>> | undefined;
  let published: Stats | undefined;
  let staged: string | undefined;
  async function clean() {
    try {
      await server?.close();
    } finally {
      try {
        const current = await lstat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (published && current?.ino === published.ino && current.dev === published.dev)
          await unlink(file);
        if (staged) await unlink(staged).catch(() => {});
      } finally {
        lock.release();
        activeFiles.delete(file);
      }
    }
  }
  try {
    lock.acquire();
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (existing) {
      privateFile(existing);
      if (!existing.isFile()) throw new Error('Desktop mods connection must be a regular file');
    }
    server = await createClaudeDesktopModsServer({
      parentDirectory: deps.socketDirectory ?? tmpdir(),
      registrationsDir: deps.registrationsDir,
      liveSessions: deps.liveSessions,
      onError: deps.onError,
      persist: async (exchange, pid, idle) => {
        const reply = await outbox.write('exchange', exchange, pid, idle);
        seen.set(exchange.sessionId, { pid, at: Date.now() });
        for (const listener of listeners) listener(exchange.sessionId);
        await deps.onExchange?.(exchange.sessionId);
        return reply;
      },
    });
    staged = `${file}.${crypto.randomUUID()}.staging`;
    await writeFile(staged, await readFile(server.connectionFile), { flag: 'wx', mode: 0o600 });
    published = await lstat(staged);
    await rename(staged, file);
    staged = undefined;
  } catch (error) {
    await clean();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    connectionFile: file,
    outbox,
    connected(sessionId: string, pid: number) {
      const entry = seen.get(sessionId);
      return entry?.pid === pid && Date.now() - entry.at < 5000;
    },
    subscribe(listener: (sessionId: string) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      closing ??= clean().finally(() => {
        const sessions = [...seen.keys()];
        seen.clear();
        for (const sessionId of sessions) for (const listener of listeners) listener(sessionId);
        listeners.clear();
      });
      return closing;
    },
  };
}
const startEnabledRuntime = (superpipe({})('start-claude-desktop-mods-runtime') as PipelineAPI)
  .input('deps')
  .pipe((deps: Deps) => configuration(deps.env), 'deps', 'result:runtime')
  .pipe(startRuntime, ['runtime', 'deps'], 'runtime')
  .endAsync('runtime') as (
  deps: Deps
) => Promise<Awaited<ReturnType<typeof startRuntime>> | undefined>;

export function createClaudeDesktopModsRuntime(deps: Deps) {
  return startEnabledRuntime(deps);
}
