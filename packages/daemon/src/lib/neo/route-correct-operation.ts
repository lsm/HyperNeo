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

const Input = z.object({ messageId: z.string().min(1), concernId: z.string().min(1) });
const Result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['main_neo_only', 'unknown_ask', 'unknown_topic']),
  }),
]);
type Input = z.infer<typeof Input>;
type Outcome = z.infer<typeof Result>;
type Gate<T> = { value: T } | { reason: Outcome };

export function requireMainNeo(
  input: Input,
  caller: OperationCaller,
  repo: NeoRepository
): Gate<Input> {
  const binding = caller.sessionId ? repo.getBindingBySession(caller.sessionId) : null;
  return binding?.kind === 'neo' && binding.concernId === null
    ? { value: input }
    : { reason: { ok: false, reason: 'main_neo_only' } };
}

export function requireLoggedAsk(route: NeoRoute | null): Gate<NeoRoute> {
  return route ? { value: route } : { reason: { ok: false, reason: 'unknown_ask' } };
}

export function requireTopicHolder(binding: NeoBinding | null): Gate<NeoBinding> {
  return binding?.kind === 'concern'
    ? { value: binding }
    : { reason: { ok: false, reason: 'unknown_topic' } };
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
    (input: Input, repo: NeoRepository) => repo.getBindingForConcern(input.concernId),
    ['input', 'repo'],
    'binding'
  )
  .pipe(requireTopicHolder, 'binding', 'result:outcome')
  .pipe(
    (route: NeoRoute, holder: NeoBinding, log: NeoRoutingLogRepository): Outcome => {
      log.correct(route.messageId, holder.concernId!, holder.sessionId);
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
      'Record that a human ask went to the wrong topic: messageId is the ask (as shown in the catch-up), concernId the topic that should have answered it. This updates the routing log so later asks route better; it does not move or answer the ask, so consult that holder separately.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input, caller) =>
      runCorrect(input, caller, new NeoRoutingLogRepository(db.getDatabase()), repo),
  });
}
