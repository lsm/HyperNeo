import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { NeoWorkDriverTargetRepository } from '../../storage/repositories/neo-work-driver-target-repository.ts';
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
import { isNeoCardLive } from './card-events.ts';
import { hasNeoHumanWorkInput, neoTurnOrigin } from './work-origin.ts';
import { neoWorkerRefKey } from './work-reroute.ts';

const ResultSchema = workResultSchema(z.object({ archived: z.boolean() }));
type Archived = Result<{ archived: boolean }>;
type Deps = WorkVerbDeps & { db: Database };
type ArchiveRoute = { daemon: string } | { local: NonNullable<WorkAdapter['archive']> };

export function admitSessionArchive(ref: WorkRef, caller: OperationCaller, db: Database) {
  const repo = new NeoRepository(db.getDatabase());
  const binding = caller.sessionId ? repo.getBindingBySession(caller.sessionId) : null;
  const turn = caller.neoTurn;
  if (
    !isLocalUser(caller) &&
    !(
      binding &&
      binding.kind !== 'worker' &&
      caller.role === 'neo' &&
      turn?.isLive() &&
      db.getSession(binding.sessionId)?.status === 'active' &&
      hasNeoHumanWorkInput(
        caller,
        db.getSDKMessageRepo().getStoredPromptsByUuid(binding.sessionId, neoTurnOrigin(turn))
      )
    )
  )
    return reject('human_only', 'Archive only when the human asks in the current live turn.');
  const targets = new NeoWorkDriverTargetRepository(db.getDatabase());
  const live = repo.listWork().some((work) => {
    if (work.status !== 'proposed' && !isNeoCardLive(work)) return false;
    const target = targets.get(work.id);
    const held =
      targets.readRef(work.id) ??
      (target && 'ref' in target ? target.ref : null) ??
      (!target && (work.sessionId || work.targetSessionId)
        ? { adapter: 'hyperneo', id: (work.sessionId || work.targetSessionId)! }
        : null);
    return held && neoWorkerRefKey(held) === neoWorkerRefKey(ref);
  });
  return live ? reject('live_card', 'Close the session’s live cards before archiving it.') : null;
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
      'Archive a session by its work.find ref through its driver, only when the human asks in the current live turn. Refuses live cards, running or waiting turns, unsupported drivers and unreadable state. Preserves the conversation. archived false means it was already archived. An attached daemon must also support this operation.',
    inputSchema: WorkRefInputSchema,
    resultSchema: ResultSchema,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => runArchive(input.ref, caller, deps),
  });
}
