import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { neoDerivedId } from './derived-id.ts';
import { frontSessionId } from './front-mode.ts';
import type { NeoService } from './service.ts';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import { ensurePrompt } from '../agent/message-delivery-outbox.ts';
import {
  createHandoffOperations,
  HandoffReadInput,
  HandoffReadResult,
} from '../handoffs/operations.ts';
import { createOperationRegistry } from '../operations/registry.ts';
import { invokeOperation } from '../operations/invoke.ts';

const Read = {
  id: z.string().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(200).optional(),
};
const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

export function createFrontTools(service: NeoService, conversationId: string) {
  const sessionId = frontSessionId(conversationId);
  const handoffs = createOperationRegistry(
    createHandoffOperations((id) => service.db.getSession(id)?.status ?? null)
  );
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
        'handoff_read',
        'Read a complete published report reference from Back Neo. The daemon verifies its SHA-256 and returns text. Continue at nextOffset until complete before summarizing.',
        HandoffReadInput.shape,
        async (input) => {
          if (
            service.repo.readConversationId() !== conversationId ||
            service.db.getGlobalSettings().neo?.front?.enabled !== true
          )
            return result({ kind: 'rejected', reason: 'front_not_speaking' });
          const outcome = await invokeOperation(handoffs, 'handoff.read', input, {
            source: 'mcp',
            role: 'neo',
            sessionId,
          });
          if (outcome.kind !== 'completed') return result(outcome);
          const read = HandoffReadResult.parse(outcome.value);
          if (read.kind !== 'read') return result(read);
          const { data, ...metadata } = read;
          return result({ ...metadata, text: Buffer.from(data, 'base64').toString('utf8') });
        }
      ),
      tool(
        'neo_send',
        'Ask Back Neo to handle a human request. Pass messageIds to deliver the complete recorded human inputs, including references and attachments. Back receives human requests only through this handoff.',
        {
          requestId: z.string().min(1).max(160),
          messageIds: z.array(z.uuid()).min(1).max(100),
          text: z.string().trim().min(1).max(16000),
        },
        async ({ requestId, messageIds, text }) => {
          const asks = messageIds.map((id) => service.asks.find(conversationId, id));
          if (asks.some((ask) => !ask))
            return result({ delivered: false, reason: 'unknown_reply_target' });
          if (
            service.repo.readConversationId() !== conversationId ||
            service.db.getGlobalSettings().neo?.front?.enabled !== true
          )
            return result({ delivered: false, reason: 'front_not_speaking' });
          for (const ask of asks) {
            if (!ask) continue;
            const message = neoIntakeMessage(
              { ...ask, sessionId: ask.askOrigin.sessionId },
              ask.askOrigin.sessionId,
              readNeoReply(ask.replyTo, service.todos),
              null,
              undefined,
              ask.previewContext ?? null
            );
            if (
              !service.db
                .getSDKMessageRepo()
                .getDeliveryMessageIdsByUuids(ask.askOrigin.sessionId, [ask.requestId]).length
            )
              await ensurePrompt({
                db: service.db.getDatabase(),
                sdkMessageRepo: service.db.getSDKMessageRepo(),
                jobQueue: service.db.getJobQueueRepo(),
                sessionId: ask.askOrigin.sessionId,
                message,
                hold: 'immediate',
                delivery: { origin: 'chat' },
              });
          }
          return result({
            delivered: await service.wakeNeo(
              neoDerivedId(`front-note:${conversationId}:${requestId}`),
              `Convo is waiting for your result for human messages ${messageIds.join(', ')}. Publish the answer through the canonical Neo publication path with these replyTo IDs. Edit an existing answer for corrections.\n${text}`
            ),
          });
        }
      ),
    ],
  });
}
