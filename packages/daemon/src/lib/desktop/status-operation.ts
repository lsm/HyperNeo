import { createConnection } from 'node:net';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import { defineOperation } from '../operations/registry.ts';
import { readProcessIdentity, type ProcessIdentity } from '../runtime-process-identity.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { desktopOptIn, readDesktopTodos, type DesktopTodoRow } from './opt-in.ts';
import { desktopPidGone, desktopRecordMissing, readDesktopDriverRecord } from './stop-operation.ts';

const State = z.enum(['off', 'unavailable', 'running', 'stopped', 'stop_unconfirmed']);
type Options = {
  dataDir?: string;
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
};

function appListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(path);
    const done = (open: boolean) => {
      clearTimeout(timer);
      client.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => done(false), 1000);
    client.once('connect', () => done(true));
    client.once('error', () => done(false));
  });
}

async function driverState(dataDir: string, worker: string, options: Options) {
  if (!(await appListening(join(dataDir, 'desktop/control.sock')))) return 'unavailable';
  const directory = join(dataDir, 'desktop/workers', worker);
  if (desktopRecordMissing(join(directory, 'driver.json'))) return 'stopped';
  try {
    const driver = readDesktopDriverRecord(directory);
    const now = await (options.readIdentity ?? readProcessIdentity)(driver.pid);
    const alive =
      now?.seconds === driver.startedAt.seconds &&
      now.microseconds === driver.startedAt.microseconds;
    if (!alive && (now || desktopPidGone(driver.pid))) return 'stopped';
    return alive && desktopRecordMissing(join(directory, 'stopped'))
      ? 'running'
      : 'stop_unconfirmed';
  } catch {
    return 'stop_unconfirmed';
  }
}

export function createDesktopStatusOperation(db: Pick<Database, 'prepare'>, options: Options = {}) {
  const status = (superpipe({})('desktop.status') as PipelineAPI)
    .input(['input'])
    .pipe((input: { worker?: string }) => readDesktopTodos(db, input.worker), 'input', 'rows')
    .pipe(
      (input: { worker?: string }, rows: DesktopTodoRow[]) =>
        Promise.all(
          (input.worker ? [input.worker] : [...new Set(rows.map((row) => row.worker))]).map(
            async (worker) => {
              const todo = desktopOptIn(rows, worker);
              if (!todo) return { worker, todo: null, state: 'off' as const };
              const state = await driverState(options.dataDir ?? getDataDir(), worker, options);
              return { worker, todo: todo.title, state };
            }
          )
        ).then((workers) => ({ workers })),
      ['input', 'rows'],
      'result'
    )
    .endAsync('result');
  return defineOperation({
    name: 'desktop.status',
    description: 'Read whether each worker desktop driver is off, unavailable, running or stopped.',
    inputSchema: z
      .object({
        worker: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
      .strict(),
    resultSchema: z.object({
      workers: z.array(z.object({ worker: z.string(), todo: z.string().nullable(), state: State })),
    }),
    policy: { safetyClass: 'human_only', caller: 'local_user' },
    execute: status,
  });
}
