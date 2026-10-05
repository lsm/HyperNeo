import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkStatus, WorkSummary } from './types.ts';

const OPEN_TASK = `status IN ('draft', 'open', 'in_progress', 'review', 'approved', 'blocked', 'rate_limited', 'usage_limited')`;
const TASKS_PER_SPACE = 20;

export interface SpacePlaceRow {
  id: string;
  name: string;
  folder: string;
  open: number;
  openCount: number;
  archivedCount: number;
  lastActiveAt: number;
}

export interface SpaceTaskRow {
  id: string;
  spaceId: string;
  taskNumber: number;
  title: string;
  status: string;
  updatedAt: number;
}

export interface SpaceAdapterDeps {
  db: () => BunDatabase;
  machine: string;
  searchTaskIds: (text: string) => ReadonlySet<string>;
}

export function spaceTaskWorkStatus(status: string): WorkStatus {
  if (status === 'in_progress' || status === 'approved') return 'running';
  if (status === 'review' || status === 'blocked') return 'needs_you';
  if (status === 'done') return 'done';
  if (status === 'cancelled' || status === 'stopped' || status === 'archived') return 'stopped';
  return 'queued';
}

export function readSpacePlaces(db: BunDatabase): SpacePlaceRow[] {
  return db
    .prepare(
      `SELECT s.id, s.name, s.workspace_path AS folder,
         CASE WHEN s.status = 'active' AND s.stopped = 0 THEN 1 ELSE 0 END AS open,
         (SELECT COUNT(*) FROM space_tasks t WHERE t.space_id = s.id AND t.${OPEN_TASK}) AS openCount,
         (SELECT COUNT(*) FROM space_tasks t WHERE t.space_id = s.id AND t.status = 'archived') AS archivedCount,
         MAX(s.updated_at, COALESCE((SELECT MAX(t.updated_at) FROM space_tasks t WHERE t.space_id = s.id), 0)) AS lastActiveAt
         FROM spaces s`
    )
    .all() as SpacePlaceRow[];
}

export function readSpaceTasks(db: BunDatabase, includeClosed: boolean): SpaceTaskRow[] {
  return db
    .prepare(
      `SELECT id, space_id AS spaceId, task_number AS taskNumber, title, status, updated_at AS updatedAt
         FROM space_tasks WHERE space_id IS NOT NULL AND (? = 1 OR ${OPEN_TASK})
        ORDER BY updated_at DESC LIMIT 500`
    )
    .all(includeClosed ? 1 : 0) as SpaceTaskRow[];
}

function toWork(task: SpaceTaskRow, space: SpacePlaceRow, machine: string): WorkSummary {
  return {
    ref: { adapter: 'space', id: task.id },
    title: `#${task.taskNumber} ${task.title}`,
    place: { machine, spaceId: space.id, name: space.name },
    status: spaceTaskWorkStatus(task.status),
    lastActivityAt: task.updatedAt,
    link: `/space/${space.id}/task/${task.id}`,
  };
}

export function buildSpaceGroups(
  spaces: readonly SpacePlaceRow[],
  tasks: readonly SpaceTaskRow[],
  query: FindQuery,
  deps: Pick<SpaceAdapterDeps, 'machine'>,
  matchedIds: ReadonlySet<string>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  return spaces
    .filter((space) => query.includeClosed || space.open === 1)
    .filter((space) => !query.spaceId || space.id === query.spaceId)
    .filter((space) => !query.folder || space.folder === query.folder)
    .flatMap((space) => {
      const placeMatches = !text || space.name.toLowerCase().includes(text);
      const work = tasks
        .filter((task) => task.spaceId === space.id)
        .filter(
          (task) =>
            placeMatches ||
            matchedIds.has(task.id) ||
            `#${task.taskNumber} ${task.title}`.toLowerCase().includes(text ?? '')
        )
        .slice(0, TASKS_PER_SPACE)
        .map((task) => toWork(task, space, deps.machine));
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: { machine: deps.machine, spaceId: space.id, name: space.name },
          lastActivityAt: space.lastActiveAt,
          openCount: space.openCount,
          archivedCount: space.archivedCount,
          adapters: ['space'],
          work,
        },
      ];
    });
}

export function loadSpacePlaces(deps: SpaceAdapterDeps): SpacePlaceRow[] {
  return readSpacePlaces(deps.db());
}

export function loadSpaceTasks(query: FindQuery, deps: SpaceAdapterDeps): SpaceTaskRow[] {
  return readSpaceTasks(deps.db(), query.includeClosed);
}

export function matchSpaceTasks(query: FindQuery, deps: SpaceAdapterDeps): ReadonlySet<string> {
  return query.text ? deps.searchTaskIds(query.text) : new Set();
}

const runSpaceFind = (superpipe({})('space-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(loadSpacePlaces, 'deps', 'spaces')
  .pipe(loadSpaceTasks, ['query', 'deps'], 'tasks')
  .pipe(matchSpaceTasks, ['query', 'deps'], 'matchedIds')
  .pipe(buildSpaceGroups, ['spaces', 'tasks', 'query', 'deps', 'matchedIds'], 'groups')
  .end('groups') as (query: FindQuery, deps: SpaceAdapterDeps) => PlaceGroup[];

export function createSpaceAdapter(deps: SpaceAdapterDeps): WorkAdapter {
  return {
    id: 'space',
    capabilities: ['find'],
    find: (query) => runSpaceFind(query, deps),
  };
}
