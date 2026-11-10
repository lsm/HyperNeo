import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { requireLocalUser } from '../operations/caller.ts';
import { SESSION_DOOR_PRINCIPAL } from '../pairing/pairing-operations.ts';
import {
  neoAskInputReads,
  neoAskInputWrites,
} from '../../storage/repositories/neo-ask-input-worker.ts';
import { globalSettingsWrites } from '../../storage/repositories/global-settings-writes.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import type { NeoService } from './service.ts';

const Input = z
  .object({
    questionId: z.string().default(''),
    where: z.string().default(''),
    when: z.string().default(''),
    words: z.string().default(''),
  })
  .strict();
const Senders = z
  .object({
    relaySenders: z.array(
      z.object({ sender: z.string().trim().min(1), name: z.string().trim().min(1) }).strict()
    ),
  })
  .strict();
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true) }),
]);

export function createNeoRelayOperations(service: NeoService) {
  const relay = (superpipe({})('neo.question.relayAnswer') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        caller.source === 'mcp' && caller.principal === SESSION_DOOR_PRINCIPAL && caller.sessionId
          ? { value: caller.sessionId }
          : {
              reason: {
                ok: false,
                reason:
                  'session_door_required: relay is accepted only through the local session door.',
              },
            },
      'caller',
      'result:outcome'
    )
    .pipe(
      (input: z.infer<typeof Input>, sender: string) =>
        service.runDbOp(neoAskInputWrites, {
          method: 'relayAnswer',
          args: [{ ...input, sender, at: Date.now() }],
        }),
      ['input', 'outcome'],
      'result:outcome'
    )
    .pipe(
      async (questionId: string) => {
        service.notifyChanged();
        await service.deliverQuestionAnswers(questionId);
        return { ok: true };
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome');
  const recent = (superpipe({})('neo.relaySenders.recent') as PipelineAPI)
    .input(['caller'])
    .pipe(requireLocalUser, 'caller', 'result:outcome')
    .pipe(
      async () => ({
        senders: await gatewayFor(service.db.getDatabase()).call(
          neoAskInputReads,
          'recentRelaySenders',
          service.repo.readConversationId(),
          service.repo.defaultBinding()?.sessionId ?? null
        ),
      }),
      'outcome',
      'outcome'
    )
    .endAsync('outcome');
  return [
    defineOperation({
      name: 'neo.relaySenders.recent',
      description: neoToolDescription('neo.relaySenders.recent'),
      inputSchema: z.object({}).strict(),
      resultSchema: z.union([
        z.object({ ok: z.literal(false), reason: z.string() }),
        z.object({
          senders: z
            .array(z.object({ sender: z.string(), name: z.string(), lastMessageAt: z.string() }))
            .max(10),
        }),
      ]),
      policy: { safetyClass: 'read', caller: 'local_user' },
      execute: (_input, caller) => recent(caller),
    }),
    defineOperation({
      name: 'neo.question.relayAnswer',
      description: neoToolDescription('neo.question.relayAnswer'),
      inputSchema: Input,
      resultSchema: Result,
      policy: { safetyClass: 'mutate' },
      execute: relay,
    }),
    defineOperation({
      name: 'neo.relaySenders.set',
      description: neoToolDescription('neo.relaySenders.set'),
      inputSchema: Senders,
      resultSchema: Result,
      policy: { safetyClass: 'human_only', caller: 'local_user' },
      execute: async (input, caller) => {
        const allowed = requireLocalUser(caller);
        if ('reason' in allowed) return allowed.reason;
        const settings = await gatewayFor(service.db.getDatabase()).call(
          globalSettingsWrites,
          'neoRelaySenders',
          input.relaySenders
        );
        service.publishSettings?.(settings);
        return { ok: true as const };
      },
    }),
  ];
}
