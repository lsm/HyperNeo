import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { neoDerivedId } from './derived-id.ts';
import { retryNeoIntake } from './intake.ts';
import type { NeoService } from './service.ts';

const Input = z.object({ conversationId: z.uuid(), requestId: z.uuid() }).strict();
type Input = z.infer<typeof Input>;
type Result = { accepted: true; requestId: string } | { accepted: false; reason: string };

const retry = (superpipe({})('neo.message.retry') as PipelineAPI)
  .input(['input', 'caller', 'service'])
  .pipe(
    (input: Input, caller: OperationCaller, service: NeoService) => {
      if (!isLocalUser(caller))
        return { reason: { accepted: false as const, reason: 'human_only' } };
      if (service.repo.conversationId() !== input.conversationId)
        return { reason: { accepted: false as const, reason: 'conversation_not_found' } };
      const ask = service.asks.find(input.conversationId, input.requestId);
      if (
        !ask ||
        service.db
          .getSDKMessageRepo()
          .getUserSendStatus(ask.askOrigin.sessionId, input.requestId) !== 'failed'
      )
        return { reason: { accepted: false as const, reason: 'not_failed' } };
      const session = service.db.getSession(ask.askOrigin.sessionId);
      if (!session || session.status === 'archived' || session.status === 'ended')
        return { reason: { accepted: false as const, reason: 'session_unavailable' } };
      return { value: { ask, session } };
    },
    ['input', 'caller', 'service'],
    'result:result'
  )
  .pipe((target) => target, 'result', 'target')
  .pipe(
    async (
      target: {
        ask: NonNullable<ReturnType<NeoService['asks']['find']>>;
        session: NonNullable<ReturnType<NeoService['db']['getSession']>>;
      },
      service: NeoService,
      caller: OperationCaller
    ) => {
      const { ask, session } = target;
      const requestId = neoDerivedId(`neo-retry:${ask.conversationId}:${ask.requestId}`);
      const thumbnails = service.asks
        .images(ask.conversationId, [ask.requestId])
        .flatMap((image) => {
          const mediaType = z
            .enum(['image/jpeg', 'image/png', 'image/webp'])
            .safeParse(image.thumbnail?.mediaType);
          if (!image.thumbnail || !mediaType.success) return [];
          return [
            {
              index: image.index,
              mediaType: mediaType.data,
              data: image.thumbnail.data,
              ...(image.width !== null ? { width: image.width } : {}),
              ...(image.height !== null ? { height: image.height } : {}),
            },
          ];
        });
      const receipt = await retryNeoIntake(
        {
          sessionId: session.id,
          requestId,
          content: ask.content,
          thumbnails,
          replyTo: ask.replyTo,
          retryOf: ask.requestId,
          ...(ask.previewContext
            ? {
                previewContext: {
                  artifactId: ask.previewContext.artifactId,
                  snapshot: ask.previewContext.snapshot,
                },
              }
            : {}),
        },
        caller,
        service.db,
        service.repo,
        () => service.notifyChanged(),
        service.todos,
        undefined,
        () => service.installedPacks()
      );
      if (!receipt.ok) return { accepted: false as const, reason: receipt.reason };
      if (!receipt.created) return { accepted: false as const, reason: 'already_retried' };
      service.notifyChanged();
      return { accepted: true as const, requestId };
    },
    ['target', 'service', 'caller'],
    'result'
  )
  .endAsync('result') as (
  input: Input,
  caller: OperationCaller,
  service: NeoService
) => Promise<Result>;

export function createNeoRetryOperation(service: NeoService) {
  return defineOperation({
    name: 'neo.message.retry',
    description: 'Resubmit a failed human input once with a new identity.',
    policy: { safetyClass: 'human_only' },
    inputSchema: Input,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({ accepted: z.literal(true), requestId: z.uuid() }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    execute: (input, caller) => retry(input, caller, service),
  });
}
