import { runtimeWorkerUrl } from '../lib/runtime-worker-url.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from './sqlite-compat.ts';

const modes = new WeakMap<Database, boolean>();

export const sdkSideOnlyWrites = (db: Database): boolean => modes.get(db) === true;

export function applySdkBodyWriteMode(db: Database, args: unknown): void {
  const mode = (args as { sdkSideOnlyWrites?: unknown } | null)?.sdkSideOnlyWrites;
  if (typeof mode === 'boolean') modes.set(db, mode);
}

const decide = (superpipe({})('sdkSideBodyStartup') as PipelineAPI)
  .input(['facts'])
  .pipe(
    ({
      complete,
      reversed,
      missing,
    }: {
      complete: boolean;
      reversed: boolean;
      missing: boolean;
    }) =>
      reversed ? 'copy_reversed' : !complete ? 'copy_incomplete' : missing ? 'body_missing' : null,
    ['facts'],
    'reason'
  )
  .end('reason') as (facts: {
  complete: boolean;
  reversed: boolean;
  missing: boolean;
}) => string | null;

function copyFacts(db: Database) {
  const markers = db
    .prepare(
      "SELECT key FROM migration_markers WHERE key IN ('sdk_message_bodies_copy_v1:complete','sdk_message_bodies_copy_v1:reversed')"
    )
    .all() as { key: string }[];
  const complete = markers.some(({ key }) => key.endsWith(':complete'));
  const reversed = markers.some(({ key }) => key.endsWith(':reversed'));
  return { complete, reversed };
}

export type SdkBodyWriteMode = { mode: 'side-only' | 'dual-write'; reason: string | null };

export async function selectSdkBodyWriteMode(db: Database): Promise<SdkBodyWriteMode> {
  const { complete, reversed } = copyFacts(db);
  let missing = false;
  if (complete && !reversed) {
    let through = 0;
    for (;;) {
      const rows = db
        .prepare('SELECT seq FROM sdk_messages WHERE seq>? ORDER BY seq LIMIT 1000')
        .all(through) as { seq: number }[];
      if (!rows.length) break;
      const ceiling = rows[rows.length - 1].seq;
      missing = Boolean(
        db
          .prepare(`SELECT m.seq FROM sdk_messages m
        LEFT JOIN sdk_message_bodies b ON b.seq=m.seq
        WHERE m.seq>? AND m.seq<=? AND b.seq IS NULL LIMIT 1`)
          .get(through, ceiling)
      );
      if (missing) break;
      through = ceiling;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const reason =
    decide({
      complete,
      reversed,
      missing,
    }) ?? null;
  modes.set(db, reason === null);
  return { mode: reason === null ? 'side-only' : 'dual-write', reason };
}

export function startSdkBodyWriteAdmission(
  db: Database,
  dbPath: string,
  report: (mode: SdkBodyWriteMode) => void,
  createWorker = () =>
    new Worker(
      runtimeWorkerUrl(
        './sdk-message-body-admission-worker.ts',
        './daemon/src/storage/sdk-message-body-admission-worker.ts',
        import.meta.url
      ).toString(),
      {
        type: 'module',
      }
    )
): () => void {
  modes.set(db, false);
  const reason = decide({ ...copyFacts(db), missing: false });
  if (reason) {
    report({ mode: 'dual-write', reason });
    return () => {};
  }
  report({ mode: 'dual-write', reason: 'coverage_pending' });
  let worker: Worker | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    worker?.terminate();
  };
  const finish = (mode: SdkBodyWriteMode) => {
    if (closed) return;
    close();
    modes.set(db, mode.mode === 'side-only');
    report(mode);
  };
  try {
    worker = createWorker();
    worker.onmessage = (event: MessageEvent<SdkBodyWriteMode>) => finish(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ mode: 'dual-write', reason: 'coverage_worker_failed' });
    };
    worker.postMessage({ dbPath });
  } catch {
    finish({ mode: 'dual-write', reason: 'coverage_worker_unavailable' });
  }
  return close;
}
