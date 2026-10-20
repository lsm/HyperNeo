import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from './sqlite-compat.ts';

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

export function assertSdkSideBodiesReady(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sdk_messages' AND type='table'").get())
    return;
  if (!db.prepare('SELECT 1 FROM sdk_messages LIMIT 1').get()) return;
  const markers = db
    .prepare(
      "SELECT key FROM migration_markers WHERE key IN ('sdk_message_bodies_copy_v1:complete','sdk_message_bodies_copy_v1:reversed')"
    )
    .all() as { key: string }[];
  const complete = markers.some(({ key }) => key.endsWith(':complete'));
  const reason = decide({
    complete,
    reversed: markers.some(({ key }) => key.endsWith(':reversed')),
    missing:
      complete &&
      Boolean(
        db
          .prepare(`SELECT m.seq FROM sdk_messages m
      LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE b.seq IS NULL LIMIT 1`)
          .get()
      ),
  });
  if (reason)
    throw new Error(
      `SDK side-only startup refused: ${reason}; run the slice-10 build (#7843) until its copy completes with every side body present before upgrading. No data was changed.`
    );
}
