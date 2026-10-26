import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { readStartedWork } from '../../storage/work-started-sessions.ts';
import { mergePlaceGroups } from '../drivers/places.ts';
import type { PlaceGroup, WorkSummary } from '../drivers/types.ts';

export const ownedNeoProjectGroups = (superpipe({})('neo-project-owned-workspaces') as PipelineAPI)
  .input(['db', 'groups'])
  .pipe(
    (db: Database) => {
      const started = new Set(readStartedWork(db).map((ref) => `${ref.adapter}\u0000${ref.id}`));
      const native = db.prepare('SELECT 1 FROM sessions WHERE id = ?');
      return (work: WorkSummary) =>
        !work.ref.daemon &&
        !work.place.daemon &&
        (started.has(`${work.ref.adapter}\u0000${work.ref.id}`) ||
          (work.ref.adapter === 'hyperneo' && !!native.get(work.ref.id)));
    },
    'db',
    'owns'
  )
  .pipe(
    (groups: readonly PlaceGroup[], owns: (work: WorkSummary) => boolean) =>
      mergePlaceGroups(
        groups.flatMap((group) =>
          group.work.filter(owns).map((work) => ({
            place: work.place,
            workspaces: [work.place],
            work: [work],
            adapters: [work.ref.adapter],
            lastActivityAt: work.lastActivityAt,
            openCount: work.status === 'stopped' ? 0 : 1,
            archivedCount: work.status === 'stopped' ? 1 : 0,
          }))
        ),
        Number.MAX_SAFE_INTEGER
      ),
    ['groups', 'owns'],
    'groups'
  )
  .end('groups') as (db: Database, groups: readonly PlaceGroup[]) => PlaceGroup[];
