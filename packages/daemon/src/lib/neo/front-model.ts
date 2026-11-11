import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { NeoSpeechSay } from './speech.ts';
import { neoDerivedId } from './derived-id.ts';
import { NeoPublicationDraft } from './publication-operation.ts';
import { frontProgressId, frontSessionId } from './front-mode.ts';
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
  const replyFields = {
    requestId: NeoPublicationDraft.shape.requestId,
    replyTo: z
      .array(z.uuid())
      .max(100)
      .optional()
      .describe(
        'The human message IDs this answers. Omit only for a background result that answers no human message.'
      ),
    publicationId: z.uuid().optional(),
    artifacts: NeoPublicationDraft.shape.artifacts,
    session: NeoPublicationDraft.shape.session,
    links: NeoPublicationDraft.shape.links,
    spoken: NeoPublicationDraft.shape.spoken.describe(
      "Required while the latest fact is [listening: yes]: one or two natural spoken lines in the human's language, consistent with the text, without paths, IDs, hashes, long numbers or Markdown. Omit when [listening: no]."
    ),
  };
  const publish = async ({
    publicationId,
    ...input
  }: z.infer<typeof NeoPublicationDraft> & { publicationId?: string; replyTo?: string[] }) => {
    const replyTo = input.replyTo ?? [];
    if (
      !publicationId &&
      !input.progress &&
      replyTo.some(
        (id) => !service.publications.get(conversationId, frontProgressId(conversationId, [id]))
      )
    )
      return result({ accepted: false, reason: 'front_ack_required' });
    if (
      !publicationId &&
      !input.spoken &&
      service.speech.isListening(service.defaultSessionId() ?? sessionId)
    )
      return result({ accepted: false, reason: 'spoken_required', listening: 'yes' });
    if (!publicationId)
      return result(await service.publish({ ...input, replyTo }, { source: 'mcp', sessionId }));
    const current = service.publications.get(conversationId, publicationId);
    const ids = current?.replyTo?.length
      ? current.replyTo
      : current?.producerInput
        ? [current.producerInput.messageId]
        : [];
    if (!current || (ids.length ? !ids.every((id) => replyTo.includes(id)) : replyTo.length))
      return result({ accepted: false, reason: 'unknown_reply_target' });
    const edited = await service.publications.reviseCurrent(
      {
        requestId: input.requestId,
        publicationId,
        fullText: input.fullText,
        shortText: input.shortText,
        verbatim: input.verbatim,
      },
      { source: 'mcp', sessionId }
    );
    if (edited.accepted) service.notifyPublicationsChanged(conversationId);
    return result(edited);
  };
  return createSdkMcpServer({
    name: 'front',
    tools: [
      ...lookups,
      tool(
        'speech_say',
        'Speak a brief natural line to the current listener. Use for spoken acknowledgments and a missing spoken reply after switching to voice. Reuse publication:<version> from the publication receipt when completing its speech.',
        NeoSpeechSay.shape,
        async (input) => {
          const say = service.speech.operations.find(
            (operation) => operation.name === 'neo.speech.say'
          )!;
          return result(await say.execute(input, { source: 'mcp', role: 'neo', sessionId }));
        }
      ),
      tool(
        'reply_short',
        'Send one plain message with no Details. Use for at most five short sentences in one brief paragraph. Use for acknowledgments, brief answers and progress updates. First call this with progress:true and the human replyTo ID for a one-sentence acknowledgment before doing work. For a final short answer omit progress. To update your existing message, pass publicationId. While [listening: yes], include spoken.',
        {
          ...replyFields,
          text: z.string().trim().min(1).max(16000),
          progress: z.literal(true).optional(),
        },
        async ({ text, ...input }) => publish({ ...input, fullText: text, verbatim: true })
      ),
      tool(
        'reply_detailed',
        'Use for more than five sentences or any structured report, multi-topic update, list, table or long Back report. Provide a standalone summary and additional details. Details must add information beyond the summary. Give the human replyTo IDs it answers. Use publicationId to update an existing answer. Start the conversation with reply_short, then use this for the full result. While [listening: yes], include spoken.',
        {
          ...replyFields,
          summary: z.string().trim().min(1).max(2000),
          details: z.string().trim().min(1).max(16000),
        },
        async ({ summary, details, ...input }) =>
          publish({ ...input, shortText: summary, fullText: details })
      ),
      tool(
        'handoff_read',
        'Read a complete report reference produced by your background work. The daemon verifies its SHA-256 and returns text. Continue at nextOffset until complete before summarizing.',
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
        'run_in_background',
        'Run work for a human request in the background: actions, searches, screenshots, checks and anything your other tools cannot do. Pass messageIds so it receives the complete recorded human inputs, including references and attachments. Its result returns to you as a background result. This is your own work: tell the human what you are doing, never who does it.',
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
          if (
            messageIds.some(
              (id) =>
                !service.publications.get(conversationId, frontProgressId(conversationId, [id]))
            )
          )
            return result({ delivered: false, reason: 'front_ack_required' });
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
              `Convo is waiting for your result for human messages ${messageIds.join(', ')}. Send the result, original human IDs and references to Convo using message.send {to: "${sessionId}", text: "...", idempotencyKey: "..."}. Only Convo publishes or speaks to the human in dual-model mode.\n${text}`
            ),
          });
        }
      ),
    ],
  });
}
