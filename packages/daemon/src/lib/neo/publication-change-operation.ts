import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type {
  NeoPublication,
  NeoPublicationChangeResult,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import { NeoPublicationSchema } from './publication.ts';
import { requirePublicationProducer } from './publication-operation.ts';

type Producer = Extract<ReturnType<typeof requirePublicationProducer>, { value: unknown }>['value'];
type Rejection = { accepted: false; reason: string };
type Owned = { producer: Producer; publication: NeoPublication };

const EditInput = z
  .object({
    publicationId: z.string().uuid(),
    shortText: NeoPublicationSchema.shape.shortText.optional(),
    fullText: NeoPublicationSchema.shape.fullText.optional(),
  })
  .strict()
  .refine((input) => input.shortText !== undefined || input.fullText !== undefined, {
    message: 'Pass shortText, fullText or both.',
  });
const CorrectInput = z
  .object({
    publicationId: z.string().uuid(),
    correctionId: z.string().uuid(),
    shortText: NeoPublicationSchema.shape.shortText,
    fullText: NeoPublicationSchema.shape.fullText,
  })
  .strict();

const Result = z.union([
  z.object({ accepted: z.literal(false), reason: z.string() }),
  z.object({
    accepted: z.literal(true),
    created: z.boolean(),
    publication: NeoPublicationSchema.extend({
      sequence: z.number().int().positive(),
      createdAt: z.string(),
    }),
  }),
]);

export interface NeoPublicationChangeRuntime {
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  publications: Pick<NeoPublicationRepository, 'get' | 'edit' | 'correct' | 'listByProducer'>;
  isConsultationReturn(conversationId: string, publicationId: string): boolean;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  inputTrigger(input: NeoAskOrigin): string | null;
  isTriggerPublished(conversationId: string, triggerId: string, publicationId: string): boolean;
  notify(conversationId: string): void;
  noteReply(publication: NeoPublication): void;
}

export function requireOwnPublication(
  producer: Producer,
  publication: NeoPublication | null
): { value: Owned } | { reason: Rejection } {
  if (!publication) return { reason: { accepted: false, reason: 'not_found' } };
  return publication.producerInput.sessionId === producer.input.sessionId
    ? { value: { producer, publication } }
    : { reason: { accepted: false, reason: 'not_your_publication' } };
}

export function requireChangeable(
  owned: Owned,
  consultationReturn: boolean
): { value: Owned } | { reason: Rejection } {
  return consultationReturn
    ? { reason: { accepted: false, reason: 'consultation_return' } }
    : { value: owned };
}

export function requireCorrectable(owned: Owned): { value: Owned } | { reason: Rejection } {
  return owned.publication.corrects
    ? { reason: { accepted: false, reason: 'already_corrected' } }
    : { value: owned };
}

export function planNeoCorrectionAnswer(
  owned: Owned,
  trigger: string | null,
  published: boolean,
  ask: NeoAskOrigin | null
): { askOrigin: NeoAskOrigin; triggerId?: string } {
  return trigger && !published && ask
    ? { askOrigin: ask, triggerId: trigger }
    : { askOrigin: owned.publication.askOrigin };
}

const RecentInput = z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict();

function changePipeline(
  name: string,
  schema: z.ZodType,
  runtime: NeoPublicationChangeRuntime,
  gate: (owned: Owned) => { value: Owned } | { reason: Rejection },
  change: (owned: Owned, input: never) => NeoPublicationChangeResult
) {
  return (superpipe({})(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: unknown) => {
        const parsed = schema.safeParse(input);
        return parsed.success
          ? { value: parsed.data }
          : { reason: { accepted: false, reason: 'invalid_publication' } };
      },
      'input',
      'result:change'
    )
    .pipe((change: unknown) => change, 'change', 'request')
    .pipe(
      (caller: OperationCaller) =>
        requirePublicationProducer(
          caller,
          runtime.getBinding(caller.sessionId ?? ''),
          runtime.getRootBinding()
        ),
      'caller',
      'result:change'
    )
    .pipe(
      (producer: Producer, request: { publicationId: string }) =>
        requireOwnPublication(
          producer,
          runtime.publications.get(producer.root.sessionId.slice(4), request.publicationId)
        ),
      ['change', 'request'],
      'result:change'
    )
    .pipe(
      (owned: Owned) =>
        requireChangeable(
          owned,
          runtime.isConsultationReturn(
            owned.publication.conversationId,
            owned.publication.publicationId
          )
        ),
      'change',
      'result:change'
    )
    .pipe(gate, 'change', 'result:change')
    .pipe(
      (owned: Owned, request: never) => {
        const result = change(owned, request);
        if (result.accepted) runtime.notify(result.publication.conversationId);
        return result;
      },
      ['change', 'request'],
      'change'
    )
    .end('change') as (
    input: unknown,
    caller: OperationCaller
  ) => NeoPublicationChangeResult | Rejection;
}

export function createNeoPublicationChangeOperations(
  runtime: NeoPublicationChangeRuntime,
  now: () => Date = () => new Date()
) {
  const edit = changePipeline(
    'neo-publication-edit',
    EditInput,
    runtime,
    (owned) => ({ value: owned }),
    (owned, input: z.infer<typeof EditInput>) =>
      runtime.publications.edit(
        owned.publication.conversationId,
        owned.publication.publicationId,
        {
          ...(input.shortText !== undefined ? { shortText: input.shortText } : {}),
          ...(input.fullText !== undefined ? { fullText: input.fullText } : {}),
        },
        now().toISOString()
      )
  );
  const correct = changePipeline(
    'neo-publication-correct',
    CorrectInput,
    runtime,
    requireCorrectable,
    (owned, input: z.infer<typeof CorrectInput>) => {
      const trigger = runtime.inputTrigger(owned.producer.input);
      const answer = planNeoCorrectionAnswer(
        owned,
        trigger,
        !!trigger &&
          runtime.isTriggerPublished(owned.publication.conversationId, trigger, input.correctionId),
        runtime.resolveAskOrigin(owned.producer.input)
      );
      const result = runtime.publications.correct(owned.publication, {
        conversationId: owned.publication.conversationId,
        publicationId: input.correctionId,
        ...answer,
        producerInput: owned.producer.input,
        shortText: input.shortText,
        fullText: input.fullText,
        links: [],
      });
      if (result.accepted && result.created && result.publication.triggerId)
        runtime.noteReply(result.publication);
      return result;
    }
  );
  const recent = (superpipe({})('neo-publication-recent') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: unknown) => {
        const parsed = RecentInput.safeParse(input ?? {});
        return parsed.success
          ? { value: parsed.data }
          : { reason: { accepted: false, reason: 'invalid_input' } };
      },
      'input',
      'result:recent'
    )
    .pipe((request: z.infer<typeof RecentInput>) => request, 'recent', 'request')
    .pipe(
      (caller: OperationCaller) =>
        requirePublicationProducer(
          caller,
          runtime.getBinding(caller.sessionId ?? ''),
          runtime.getRootBinding()
        ),
      'caller',
      'result:recent'
    )
    .pipe(
      (producer: Producer, request: z.infer<typeof RecentInput>) => ({
        accepted: true,
        publications: runtime.publications
          .listByProducer(producer.root.sessionId.slice(4), producer.input.sessionId, request.limit)
          .map((publication) => ({
            publicationId: publication.publicationId,
            createdAt: publication.createdAt,
            shortText: publication.shortText,
            askMessageId: publication.askOrigin.messageId,
            ...(publication.editedAt ? { editedAt: publication.editedAt } : {}),
            ...(publication.corrects ? { corrects: publication.corrects } : {}),
            ...(publication.correctedBy ? { correctedBy: publication.correctedBy } : {}),
          })),
      }),
      ['recent', 'request'],
      'recent'
    )
    .end('recent') as (input: unknown, caller: OperationCaller) => unknown;
  return [
    defineOperation({
      name: 'neo.publication.recent',
      description:
        "List your own most recent published messages in this conversation, newest first (limit 1-20, default 10), with each publicationId, createdAt, shortText, the human message it answered and any editedAt, corrects or correctedBy. Use it to find the publicationId to edit or correct. It never lists session messages or another session's publications.",
      policy: { safetyClass: 'read', roles: ['neo'] },
      inputSchema: RecentInput,
      resultSchema: z.unknown(),
      execute: async (input, caller) => recent(input, caller),
    }),
    defineOperation({
      name: 'neo.publication.edit',
      description:
        "Fix the wording of one of your own published messages in place, by its publicationId. Use it only for wording: the meaning, facts and anything the human should do must stay the same. The message is marked edited. Links, the ask it answers and its trigger never change. Only the session that published it can edit it; anything else, including session messages and other sessions' output, is refused (not_found, not_your_publication). A project holder's reply to a consultation is the record the consultation returns, so it cannot be changed (consultation_return).",
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: EditInput,
      resultSchema: Result,
      execute: async (input, caller) => edit(input, caller),
    }),
    defineOperation({
      name: 'neo.publication.correct',
      description:
        'Correct one of your own published messages when a fact or an action for the human changed (for example it said a PR merged and it did not). This publishes a separate message labelled as a correction that cites the original by publicationId; it never rewrites what the human already read. Pass a new correctionId (reuse it only for identical retries). When this turn answers a human message (or a trigger note) that has no reply yet, the correction is that reply, so do not publish a separate one. Each message takes at most one correction, and a correction cannot be corrected (already_corrected). Only the session that published the original can correct it (not_found, not_your_publication), and a consultation reply cannot be corrected (consultation_return). Otherwise it needs no notification trigger.',
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: CorrectInput,
      resultSchema: Result,
      execute: async (input, caller) => correct(input, caller),
    }),
  ];
}
