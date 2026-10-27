import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isNeoConversationSession } from './publication-read-operation.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import { workResultSchema, type Result, type WorkRef, type WorkAdapter } from '../drivers/types.ts';
import {
  forwardWork,
  pickRoute,
  reject,
  WorkRefInputSchema,
  type WorkVerbDeps,
} from '../drivers/work-operations.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

const ResultSchema = workResultSchema(z.object({ archived: z.boolean() }));
type Archived = Result<{ archived: boolean }>;
type Deps = WorkVerbDeps & { db: Database };
type ArchiveRoute = { daemon: string } | { local: NonNullable<WorkAdapter['archive']> };

export function admitSessionArchive(ref: WorkRef, caller: OperationCaller, db: Database) {
  const binding = caller.sessionId
    ? new NeoRepository(db.getDatabase()).getBindingBySession(caller.sessionId)
    : null;
  if (!isLocalUser(caller) && !isNeoConversationSession(caller, binding))
    return reject('human_only', 'This action needs the user or a bound Neo session.');
  const todo = new NeoTodoSessionRepository(db.getDatabase()).doingTodoOn(ref);
  return todo
    ? reject(
        'live_todo',
        `Todo "${todo.title}" is still working in this session; finish or drop it first.`
      )
    : null;
}

async function archiveSession(
  route: ArchiveRoute,
  ref: WorkRef,
  caller: OperationCaller,
  deps: Deps
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
    return await route.local(ref, () => admitSessionArchive(ref, caller, deps.db));
  } catch (error) {
    return reject('unreachable', error instanceof Error ? error.message : String(error));
  }
}

const runArchive = (superpipe({})('neo.session.archive') as PipelineAPI)
  .input(['ref', 'caller', 'deps'])
  .pipe(
    (ref: WorkRef, caller: OperationCaller, deps: Deps) => {
      const refused = admitSessionArchive(ref, caller, deps.db);
      return refused ? { reason: refused } : { value: ref };
    },
    ['ref', 'caller', 'deps'],
    'result:outcome'
  )
  .pipe(
    (ref: WorkRef, deps: Deps) => pickRoute('archive', ref, deps.adapters()),
    ['outcome', 'deps'],
    'result:outcome'
  )
  .pipe(archiveSession, ['outcome', 'ref', 'caller', 'deps'], 'outcome')
  .endAsync('outcome') as (ref: WorkRef, caller: OperationCaller, deps: Deps) => Promise<Archived>;

export function createNeoSessionArchiveOperation(deps: Deps) {
  return defineOperation({
    name: 'neo.session.archive',
    description:
      'Archive a session by its work.find ref through its driver, through the human caller or a bound Neo session. Refuses sessions a doing todo is working in, running or waiting turns, unsupported drivers and unreadable state. Preserves the conversation. archived false means it was already archived. An attached daemon must also support this operation.',
    inputSchema: WorkRefInputSchema,
    resultSchema: ResultSchema,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => runArchive(input.ref, caller, deps),
  });
}
