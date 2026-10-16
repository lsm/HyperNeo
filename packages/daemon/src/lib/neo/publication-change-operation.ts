import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { neoKnownIds } from './known-ids.ts';
import type {
  NeoPublication,
  NeoPublicationChangeResult,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import { neoDerivedId } from './derived-id.ts';
import { NeoPublicationSchema } from './publication.ts';
import { requirePublicationProducer } from './publication-operation.ts';

type Producer = Extract<ReturnType<typeof requirePublicationProducer>, { value: unknown }>['value'];
type Rejection = { accepted: false; reason: string; detail?: string };
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
    shortText: NeoPublicationSchema.shape.shortText,
    fullText: NeoPublicationSchema.shape.fullText,
  })
  .strict();

const Result = z.union([
  z.object({ accepted: z.literal(false), reason: z.string(), detail: z.string().optional() }),
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
  publications: Pick<NeoPublicationRepository, 'get' | 'edit' | 'correct' | 'listRecent'>;
  isConsultationReturn(conversationId: string, publicationId: string): boolean;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  inputTrigger(input: NeoAskOrigin): string | null;
  isTriggerPublished(conversationId: string, triggerId: string, publicationId: string): boolean;
  notify(conversationId: string): void;
  noteReply(publication: NeoPublication): void;
}

export function requireConversationPublication(
  producer: Producer,
  publication: NeoPublication | null,
  recent: readonly NeoPublication[] = []
): { value: Owned } | { reason: Rejection } {
  return publication
    ? { value: { producer, publication } }
    : {
        reason: {
          accepted: false,
          reason: 'not_found',
          detail: `No Neo reply in this conversation has that publicationId. ${neoKnownIds(
            'recent replies',
            recent.map((item) => ({ id: item.publicationId, title: item.shortText }))
          )}`,
        },
      };
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

export function requireNeoEditable(
  owned: Owned,
  text: { shortText?: string; fullText?: string }
): { value: Owned } | { reason: Rejection } {
  const { publication, producer } = owned;
  if (
    (text.shortText ?? publication.shortText) === publication.shortText &&
    (text.fullText ?? publication.fullText) === publication.fullText
  )
    return { reason: { accepted: false, reason: 'edit_unchanged' } };
  const last = publication.answerInput ?? publication.producerInput;
  return last.sessionId === producer.input.sessionId &&
    last.messageId === producer.input.messageId &&
    !!publication.editedAt
    ? { reason: { accepted: false, reason: 'already_edited' } }
    : { value: owned };
}

export function neoCorrectionId(owned: Owned, trigger: string | null): string {
  const { conversationId, publicationId } = owned.publication;
  const turn = trigger ?? `${owned.producer.input.sessionId}:${owned.producer.input.messageId}`;
  return neoDerivedId(`neo.publication.correct:${conversationId}:${publicationId}:${turn}`);
}

const RecentInput = z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict();

function changePipeline(
  name: string,
  schema: z.ZodType,
  runtime: NeoPublicationChangeRuntime,
  gate: (owned: Owned, request: never) => { value: Owned } | { reason: Rejection },
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
        requireConversationPublication(
          producer,
          runtime.publications.get(producer.root.sessionId.slice(4), request.publicationId),
          runtime.publications.listRecent(producer.root.sessionId.slice(4), 8)
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
    .pipe(gate, ['change', 'request'], 'result:change')
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
    (owned, input: z.infer<typeof EditInput>) => requireNeoEditable(owned, input),
    (owned, input: z.infer<typeof EditInput>) =>
      runtime.publications.edit(
        owned.publication.conversationId,
        owned.publication.publicationId,
        {
          ...(input.shortText !== undefined ? { shortText: input.shortText } : {}),
          ...(input.fullText !== undefined ? { fullText: input.fullText } : {}),
        },
        now().toISOString(),
        owned.producer.input.sessionId,
        owned.producer.input
      )
  );
  const correct = changePipeline(
    'neo-publication-correct',
    CorrectInput,
    runtime,
    (owned: Owned) => requireCorrectable(owned),
    (owned, input: z.infer<typeof CorrectInput>) => {
      const trigger = runtime.inputTrigger(owned.producer.input);
      const correctionId = neoCorrectionId(owned, trigger);
      const answer = planNeoCorrectionAnswer(
        owned,
        trigger,
        !!trigger &&
          runtime.isTriggerPublished(owned.publication.conversationId, trigger, correctionId),
        runtime.resolveAskOrigin(owned.producer.input)
      );
      const result = runtime.publications.correct(owned.publication, {
        conversationId: owned.publication.conversationId,
        publicationId: correctionId,
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
          .listRecent(producer.root.sessionId.slice(4), request.limit)
          .map((publication) => ({
            publicationId: publication.publicationId,
            createdAt: publication.createdAt,
            shortText: publication.shortText,
            askMessageId: publication.askOrigin.messageId,
            producer: publication.producerInput.sessionId,
            yours: publication.producerInput.sessionId === producer.input.sessionId,
            ...(publication.editedAt ? { editedAt: publication.editedAt } : {}),
            ...(publication.editedBy ? { editedBy: publication.editedBy } : {}),
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
        'List the most recent published messages in this conversation, newest first (limit 1-20, default 10): every Neo reply the human sees, whichever Neo session produced it. Each has its publicationId, createdAt, shortText, the human message it answered, its producer, whether it is yours, and any editedAt, editedBy, corrects or correctedBy. Read it before fixing an earlier reply, and use its content rather than re-deriving it. It never lists session messages.',
      policy: { safetyClass: 'read', roles: ['neo'] },
      inputSchema: RecentInput,
      resultSchema: z.unknown(),
      execute: async (input, caller) => recent(input, caller),
    }),
    defineOperation({
      name: 'neo.publication.edit',
      description:
        "Fix the wording of a Neo reply in this conversation in place, by its publicationId, whichever Neo session produced it: to the human they are all Neo's. Use it only for wording: the meaning, facts and anything the human should do must stay the same. Once per message per turn; otherwise already_edited, and an edit that changes nothing is edit_unchanged. A new fact goes out as its own message, never by rewriting what the human already read. The message is marked edited, records you as editedBy, and drops its awaiting question. Links, the ask it answers and its trigger never change. Only Neo publications in this conversation can change, never session messages (not_found). A project holder's reply to a consultation cannot change until Neo has received it (consultation_return); after that it is a Neo reply like any other.",
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: EditInput,
      resultSchema: Result,
      execute: async (input, caller) => edit(input, caller),
    }),
    defineOperation({
      name: 'neo.publication.correct',
      description:
        "Correct a Neo reply in this conversation, whichever Neo session produced it, when a fact or an action for the human changed (for example it said a PR merged and it did not). This publishes a separate message labelled as a correction that cites the original by publicationId; it never rewrites what the human already read. Base it on the original's content and fresh evidence, not a guess. The daemon assigns the correction's id and returns it; a retry within the same turn returns the same correction. When this turn answers a human message (or a trigger note) that has no reply yet, the correction is that reply, so do not publish a separate one. Each message takes at most one correction, and a correction cannot be corrected (already_corrected). Only Neo publications in this conversation can be corrected (not_found), and a holder's consultation reply only once Neo has received it (consultation_return). Otherwise it needs no notification trigger.",
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: CorrectInput,
      resultSchema: Result,
      execute: async (input, caller) => correct(input, caller),
    }),
  ];
}
