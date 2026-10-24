import { getConfig } from '../../config.ts';
import {
  forwardSQLiteWorkerLog,
  type SQLiteWorkerLog,
} from '../../storage/sqlite-worker-observability.ts';
import { resolve } from 'node:path';
import type { Database } from '../../storage/database.ts';
import type { PlaceGroup } from '../drivers/types.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import { mirrorNeoWorkspaceProjects } from './project-mirror.ts';

const pending = new Map<string, Promise<boolean>>();
const createWorker = () =>
  new Worker(new URL('./project-mirror-worker.ts', import.meta.url).href, { type: 'module' });

export function mirrorNeoWorkspaceProjectsAsync(
  db: Pick<Database, 'getDbPath' | 'getDatabase'>,
  groups: readonly PlaceGroup[],
  spawn: () => Worker = createWorker
): Promise<boolean> {
  if (db.getDbPath() === ':memory:')
    return Promise.resolve(mirrorNeoWorkspaceProjects(db.getDatabase(), groups));
  const path = resolve(db.getDbPath());
  const run = (pending.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(
      () =>
        new Promise<boolean>((done, fail) => {
          let worker: Worker | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;
          const finish = (changed: boolean, error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker?.terminate();
            if (error) fail(error);
            else done(changed);
          };
          try {
            worker = runLagPhase('neo:project_mirror:worker_start', spawn);
            worker.onmessage = (
              event: MessageEvent<{ changed: boolean } | { error: string } | SQLiteWorkerLog>
            ) => {
              if ('log' in event.data) {
                forwardSQLiteWorkerLog(event.data, 'project-mirror');
                return;
              }
              if ('error' in event.data) finish(false, new Error(event.data.error));
              else finish(event.data.changed);
            };
            worker.onerror = (event) => finish(false, new Error(event.message));
            timer = setTimeout(
              () => finish(false, new Error('Project mirror worker timed out')),
              30_000
            );
            worker.postMessage({
              dbPath: path,
              groups,
              requestId: crypto.randomUUID(),
              queryObservability: getConfig().sqlQueryObservability,
            });
          } catch (error) {
            finish(false, error instanceof Error ? error : new Error(String(error)));
          }
        })
    );
  pending.set(path, run);
  const clear = () => {
    if (pending.get(path) === run) pending.delete(path);
  };
  void run.then(clear, clear);
  return run;
}
