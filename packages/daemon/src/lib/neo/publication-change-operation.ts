import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type {
  NeoPublication,
  NeoPublicationChangeResult,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { neoDerivedId } from './derived-id.ts';
import { neoKnownIds } from './known-ids.ts';
import { NeoPublicationObject, NeoPublicationResultSchema } from './publication.ts';
import { requirePublicationLifetime, requirePublicationProducer } from './publication-operation.ts';

type Producer = Extract<ReturnType<typeof requirePublicationProducer>, { value: unknown }>['value'];
type Rejection = { accepted: false; reason: string; detail?: string };
type Owned = { producer: Producer; publication: NeoPublication };

const EditInput = z
  .object({
    requestId: z.string().min(1).max(160),
    publicationId: z.string().uuid(),
    shortText: NeoPublicationObject.shape.shortText.optional(),
    fullText: NeoPublicationObject.shape.fullText.optional(),
  })
  .strict()
  .refine((input) => input.shortText !== undefined || input.fullText !== undefined, {
    message: 'Pass shortText, fullText or both.',
  });

export interface NeoPublicationChangeRuntime {
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  publications: Pick<NeoPublicationRepository, 'get' | 'edit' | 'listRecent'>;
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
            recent.map((item) => ({
              id: item.publicationId,
              title: item.shortText ?? item.fullText,
            }))
          )}`,
        },
      };
}

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
      (owned: Owned, caller: OperationCaller) => {
        const live = requirePublicationLifetime(
          owned.producer,
          caller,
          runtime.getBinding(owned.producer.binding.sessionId),
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
          owned.producer.binding.sessionId,
          undefined,
          neoDerivedId(JSON.stringify([name, owned.producer.binding.sessionId, input.requestId])),
          undefined
        )
    );
  const edit = revise('neo.publication.edit', EditInput);
  return [
    defineOperation({
      name: 'neo.publication.edit',
      description:
        'Revise a message in this conversation without changing its publicationId. Prior text and attribution are preserved in revisions. Use a new requestId per revision and reuse it only when retrying that operation.',
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      inputSchema: EditInput,
      resultSchema: NeoPublicationResultSchema,
      execute: async (input, caller) => edit(input, caller),
    }),
  ];
}
