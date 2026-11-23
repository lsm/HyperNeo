import type { UnarchiveSessionResponse } from '@hyperneo/shared';
import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { SessionManager } from '../session-manager.ts';
import { isNeoConversationSession } from './publication-read-operation.ts';

function admitUnarchive(sessionId: string, caller: OperationCaller, db: Database) {
  const binding = caller.sessionId
    ? new NeoRepository(db.getDatabase()).getBindingBySession(caller.sessionId)
    : null;
  return isLocalUser(caller) || isNeoConversationSession(caller, binding)
    ? { value: sessionId }
    : { reason: { success: false, reason: 'This action needs the user or a bound Neo session.' } };
}

const runUnarchive = (superpipe({})('neo.session.unarchive') as PipelineAPI)
  .input(['sessionId', 'caller', 'db', 'sessions'])
  .pipe(admitUnarchive, ['sessionId', 'caller', 'db'], 'result:outcome')
  .pipe(
    (sessionId: string, sessions: SessionManager) =>
      sessions.getSessionLifecycle().unarchive(sessionId),
    ['outcome', 'sessions'],
    'outcome'
  )
  .endAsync('outcome') as (
  sessionId: string,
  caller: OperationCaller,
  db: Database,
  sessions: SessionManager
) => Promise<UnarchiveSessionResponse>;

export function createNeoSessionUnarchiveOperation(db: Database, sessions: SessionManager) {
  return defineOperation({
    name: 'neo.session.unarchive',
    description: neoToolDescription('neo.session.unarchive'),
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    resultSchema: z.discriminatedUnion('success', [
      z.object({ success: z.literal(true), worktreeBaseBranch: z.string().optional() }),
      z.object({ success: z.literal(false), reason: z.string() }),
    ]),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => runUnarchive(input.sessionId, caller, db, sessions),
  });
}
