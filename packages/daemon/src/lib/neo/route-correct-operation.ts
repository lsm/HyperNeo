import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
} from '../../storage/repositories/neo-routing-log-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isMainNeoBinding } from './binding-roles.ts';

const Input = z.object({ messageId: z.string().min(1), projectId: z.string().min(1) });
const Result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['main_neo_only', 'unknown_ask', 'unknown_project']),
  }),
]);
type Input = z.infer<typeof Input>;
type Outcome = z.infer<typeof Result>;
type Gate<T> = { value: T } | { reason: Outcome };

function requireMainNeo(input: Input, caller: OperationCaller, repo: NeoRepository): Gate<Input> {
  const binding = caller.sessionId ? repo.getBindingBySession(caller.sessionId) : null;
  return isMainNeoBinding(binding)
    ? { value: input }
    : { reason: { ok: false, reason: 'main_neo_only' } };
}

function requireLoggedAsk(route: NeoRoute | null): Gate<NeoRoute> {
  return route ? { value: route } : { reason: { ok: false, reason: 'unknown_ask' } };
}

function requireProjectHolder(binding: NeoBinding | null): Gate<NeoBinding> {
  return binding?.kind === 'project'
    ? { value: binding }
    : { reason: { ok: false, reason: 'unknown_project' } };
}

const runCorrect = (superpipe({})('neo-route-correct') as PipelineAPI)
  .input(['input', 'caller', 'log', 'repo'])
  .pipe(requireMainNeo, ['input', 'caller', 'repo'], 'result:outcome')
  .pipe(
    (input: Input, log: NeoRoutingLogRepository) => log.find(input.messageId),
    ['outcome', 'log'],
    'logged'
  )
  .pipe(requireLoggedAsk, 'logged', 'result:outcome')
  .pipe(
    (input: Input, repo: NeoRepository) => repo.getBindingForProject(input.projectId),
    ['input', 'repo'],
    'binding'
  )
  .pipe(requireProjectHolder, 'binding', 'result:outcome')
  .pipe(
    (route: NeoRoute, holder: NeoBinding, log: NeoRoutingLogRepository): Outcome => {
      log.correct(route.messageId, holder.projectId!, holder.sessionId);
      return { ok: true };
    },
    ['logged', 'outcome', 'log'],
    'outcome'
  )
  .end('outcome') as (
  input: Input,
  caller: OperationCaller,
  log: NeoRoutingLogRepository,
  repo: NeoRepository
) => Outcome;

export function createNeoRouteCorrectOperation(db: Database, repo: NeoRepository) {
  return defineOperation({
    name: 'neo.route.correct',
    description:
      'Record that a human ask went to the wrong project: messageId is the ask (as shown in the catch-up), projectId the project that should have answered it. This updates the routing log so later asks route better; it does not move or answer the ask, so consult that holder separately.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input, caller) =>
      runCorrect(input, caller, new NeoRoutingLogRepository(db.getDatabase()), repo),
  });
}
