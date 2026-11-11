import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { NeoPublicationDraft } from './publication-operation.ts';
import { neoDerivedId } from './derived-id.ts';
import { frontSessionId } from './front-mode.ts';
import type { NeoService } from './service.ts';

const Read = {
  id: z.string().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(200).optional(),
};
const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

export function createFrontTools(service: NeoService, conversationId: string) {
  const sessionId = frontSessionId(conversationId);
  const lookups = (['projects', 'asks', 'cards', 'todos'] as const).map((kind) =>
    tool(`${kind}_read`, `Read current ${kind} for this conversation.`, Read, async (input) =>
      result(
        await service.db.gateway.run(neoFrontReads, {
          conversationId,
          kind,
          input: input.id ? { id: input.id } : input.text ? { text: input.text } : {},
        })
      )
    )
  );
  return createSdkMcpServer({
    name: 'front',
    tools: [
      ...lookups,
      tool(
        'publication_publish',
        'Publish a reply to the human. Use replyTo for the original human message IDs. Plain assistant text stays internal.',
        { ...NeoPublicationDraft.shape, replyTo: z.array(z.uuid()).min(1).max(100) },
        async (input) => {
          const known = input.replyTo.every((id) => service.asks.find(conversationId, id));
          return result(
            known
              ? await service.publish(input, { source: 'mcp', sessionId })
              : { accepted: false, reason: 'unknown_reply_target' }
          );
        }
      ),
      tool(
        'neo_send',
        'Send an internal note to Back Neo. Include the original human message IDs. The human message already reaches Back Neo.',
        { requestId: z.string().min(1).max(160), text: z.string().trim().min(1).max(16000) },
        async ({ requestId, text }) =>
          result({
            delivered: await service.wakeNeo(
              neoDerivedId(`front-note:${conversationId}:${requestId}`),
              text
            ),
          })
      ),
    ],
  });
}
