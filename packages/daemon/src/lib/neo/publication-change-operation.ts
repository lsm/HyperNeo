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
import { neoDerivedId } from './derived-id.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import { NeoPublicationSchema } from './publication.ts';
import {
  requirePublicationLifetime,
  requirePublicationProducer,
  requirePublicationNotConsulted,
} from './publication-operation.ts';

type Producer = Extract<ReturnType<typeof requirePublicationProducer>, { value: unknown }>['value'];
type Rejection = { accepted: false; reason: string; detail?: string };
type Owned = { producer: Producer; publication: NeoPublication };

const EditInput = z
  .object({
    requestId: z.string().min(1).max(160),
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
    requestId: z.string().min(1).max(160),
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
  publications: Pick<NeoPublicationRepository, 'get' | 'edit' | 'listRecent'>;
  isConsultationReturn(conversationId: string, publicationId: string): boolean;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  notify(conversationId: string): void;
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

const RecentInput = z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict();

function changePipeline(
  name: string,
  schema: z.ZodType,
  runtime: NeoPublicationChangeRuntime,
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
    .pipe(requirePublicationNotConsulted, 'change', 'result:change')
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
    .pipe(
      (owned: Owned, caller: OperationCaller) => {
        const live = requirePublicationLifetime(
          { ...owned.producer, ask: owned.publication.askOrigin },
          caller,
          runtime.getBinding(owned.producer.input.sessionId),
          runtime.getRootBinding()
        );
        return 'reason' in live ? live : { value: owned };
      },
      ['change', 'caller'],
      'result:change'
    )
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
  const revise = (name: string, schema: z.ZodType) =>
    changePipeline(
      name,
      schema,
      runtime,
      (owned, input: { requestId: string; shortText?: string; fullText?: string }) =>
        runtime.publications.edit(
          owned.publication.conversationId,
          owned.publication.publicationId,
          { shortText: input.shortText, fullText: input.fullText },
          now().toISOString(),
          owned.producer.input.sessionId,
          owned.producer.input,
          neoDerivedId(
            JSON.stringify([
              name,
              owned.producer.input.sessionId,
              owned.producer.input.messageId,
              input.requestId,
            ])
          ),
          runtime.resolveAskOrigin(owned.producer.input) ?? owned.producer.input
        )
    );
  const edit = revise('neo.publication.edit', EditInput);
  const correct = revise('neo.publication.correct', CorrectInput);
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
            revisionId: publication.revisionId ?? publication.publicationId,
            revisions: publication.revisions ?? [],
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
        'List recent messages in this conversation with their IDs and revision history. Current text is top-level; revisions contains earlier versions, oldest first.',
      policy: { safetyClass: 'read', roles: ['neo'] },
      inputSchema: RecentInput,
      resultSchema: z.unknown(),
      execute: async (input, caller) => recent(input, caller),
    }),
    defineOperation({
      name: 'neo.publication.edit',
      description:
        'Revise a message in this conversation without changing its publicationId. Prior text and attribution are preserved in revisions. Use a new requestId per revision and reuse it only when retrying that operation.',
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: EditInput,
      resultSchema: Result,
      execute: async (input, caller) => edit(input, caller),
    }),
    defineOperation({
      name: 'neo.publication.correct',
      description:
        'Revise a message in this conversation without changing its publicationId. Prior text and attribution are preserved in revisions. Use a new requestId per revision and reuse it only when retrying that operation.',
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: CorrectInput,
      resultSchema: Result,
      execute: async (input, caller) => correct(input, caller),
    }),
  ];
}
