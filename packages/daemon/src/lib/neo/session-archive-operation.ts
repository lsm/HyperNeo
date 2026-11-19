import { neoToolDescription } from '@hyperneo/prompts';
import { Logger } from '../logger.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { Database as RawDatabase } from '../../storage/sqlite-compat.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import {
  workStartedSessionReads,
  workStartedSessionWrites,
} from '../../storage/repositories/work-started-sessions-worker.ts';
import { isNeoConversationSession } from './publication-read-operation.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import {
  WorkArchivedSchema,
  type WorkArchived,
  workResultSchema,
  type Result,
  type WorkRef,
  type WorkAdapter,
} from '../drivers/types.ts';
import {
  forwardWork,
  pickRoute,
  reject,
  WorkRefInputSchema,
  type WorkVerbDeps,
} from '../drivers/work-operations.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

const ResultSchema = workResultSchema(WorkArchivedSchema);
type Archived = Result<WorkArchived>;
type Deps = WorkVerbDeps & { db: Database };
type ArchiveRoute = { daemon: string } | { local: NonNullable<WorkAdapter['archive']> };

export const NEO_TODO_RELEASE_PRINCIPAL = 'neo.todo.release';
const log = new Logger('neo-session-archive');

function admitArchiveCaller(ref: WorkRef, caller: OperationCaller, db: RawDatabase) {
  const release = caller.source === 'internal' && caller.principal === NEO_TODO_RELEASE_PRINCIPAL;
  const binding = caller.sessionId
    ? new NeoRepository(db).getBindingBySession(caller.sessionId)
    : null;
  if (!release && !isLocalUser(caller) && !isNeoConversationSession(caller, binding))
    return reject('human_only', 'This action needs the user or a bound Neo session.');
  const todo = new NeoTodoSessionRepository(db).doingTodoOn(
    ref,
    null,
    release ? ['todo', 'doing', 'blocked'] : ['doing']
  );
  if (todo)
    return reject(
      'live_todo',
      `Todo "${todo.title}" is still working in this session; finish or drop it first.`
    );
  return null;
}

export function admitSessionArchive(
  ref: WorkRef,
  caller: OperationCaller,
  db: Database,
  startedByUs: boolean
) {
  const refused = admitArchiveCaller(ref, caller, db.getDatabase());
  if (refused) return refused;
  if (!isLocalUser(caller) && !startedByUs)
    return reject('not_started_by_us', 'This session was not started by the daemon.');
  return null;
}

const readStartedByUs = (
  route: ArchiveRoute,
  ref: WorkRef,
  caller: OperationCaller,
  raw: RawDatabase
) =>
  'local' in route && !isLocalUser(caller)
    ? gatewayFor(raw).call(workStartedSessionReads, 'startedByUs', ref)
    : true;

async function archiveSession(
  route: ArchiveRoute,
  ref: WorkRef,
  caller: OperationCaller,
  deps: Deps,
  started: boolean,
  raw: RawDatabase
): Promise<Archived> {
  if ('daemon' in route)
    return forwardWork(
      route.daemon,
      'neo.session.archive',
      {
        ref: { adapter: ref.adapter, id: ref.id },
      },
      ResultSchema,
      deps.remote
    );
  try {
    const result = await route.local(ref, () => admitSessionArchive(ref, caller, deps.db, started));
    if (result.ok) {
      try {
        await gatewayFor(raw).call(
          workStartedSessionWrites,
          'recordArchived',
          ref,
          caller.principal === NEO_TODO_RELEASE_PRINCIPAL ? 'todo release' : 'archive requested'
        );
      } catch (error) {
        log.error('Archive provenance write failed', ref, error);
      }
    }
    return result;
  } catch (error) {
    return reject('unreachable', error instanceof Error ? error.message : String(error));
  }
}

const runArchive = (superpipe({})('neo.session.archive') as PipelineAPI)
  .input(['ref', 'caller', 'deps'])
  .pipe((deps: Deps) => deps.db.getDatabase(), ['deps'], 'raw')
  .pipe(
    (ref: WorkRef, caller: OperationCaller, raw: RawDatabase) => {
      const refused = admitArchiveCaller(ref, caller, raw);
      return refused ? { reason: refused } : { value: ref };
    },
    ['ref', 'caller', 'raw'],
    'result:outcome'
  )
  .pipe(
    (ref: WorkRef, deps: Deps) => pickRoute('archive', ref, deps.adapters()),
    ['outcome', 'deps'],
    'result:outcome'
  )
  .pipe(readStartedByUs, ['outcome', 'ref', 'caller', 'raw'], 'started')
  .pipe(
    (route: ArchiveRoute, ref: WorkRef, caller: OperationCaller, deps: Deps, started: boolean) => {
      const refused = 'local' in route ? admitSessionArchive(ref, caller, deps.db, started) : null;
      return refused ? { reason: refused } : { value: route };
    },
    ['outcome', 'ref', 'caller', 'deps', 'started'],
    'result:outcome'
  )
  .pipe(archiveSession, ['outcome', 'ref', 'caller', 'deps', 'started', 'raw'], 'outcome')
  .endAsync('outcome') as (ref: WorkRef, caller: OperationCaller, deps: Deps) => Promise<Archived>;

export function createNeoSessionArchiveOperation(deps: Deps) {
  return defineOperation({
    name: 'neo.session.archive',
    description: neoToolDescription('neo.session.archive'),
    inputSchema: WorkRefInputSchema,
    resultSchema: ResultSchema,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => runArchive(input.ref, caller, deps),
  });
}
