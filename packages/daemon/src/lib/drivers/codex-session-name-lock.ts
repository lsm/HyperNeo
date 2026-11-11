import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseLock } from '../../storage/database-lock.ts';

const queues = new Map<string, Promise<void>>();

export async function lockCodexSessionName(
  statePath: string,
  projectFolder: string
): Promise<() => void> {
  const state = existsSync(statePath)
    ? realpathSync(statePath)
    : join(realpathSync(dirname(statePath)), basename(statePath));
  const project = existsSync(projectFolder) ? realpathSync(projectFolder) : resolve(projectFolder);
  const key = `${state}.hyperneo-session-names-${createHash('sha256').update(project).digest('hex')}`;
  const previous = queues.get(key);
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  queues.set(key, current);
  const releaseQueue = () => {
    release();
    if (queues.get(key) === current) queues.delete(key);
  };
  await previous;
  const lock = new DatabaseLock(key);
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        lock.acquire();
        break;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Another HyperNeo daemon'))
          throw error;
        if (Date.now() >= deadline)
          throw new Error('Timed out waiting for Codex session naming; retry the start.');
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    return () => {
      lock.release();
      releaseQueue();
    };
  } catch (error) {
    releaseQueue();
    throw error;
  }
}
