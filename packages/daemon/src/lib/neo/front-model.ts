import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { NeoSpeechSay } from './speech.ts';
import { NeoPublicationDraft } from './publication-operation.ts';
import { frontProgressId, frontSessionId } from './front-mode.ts';
import type { NeoService } from './service.ts';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import { neoFrontInputWrites } from '../../storage/repositories/neo-front-input-worker.ts';

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
    tool(`${kind}_read`, `Read current ${kind} for this conversation.`, Read, async (input) => {
      const value = await service.db.gateway.run(neoFrontReads, {
        conversationId,
        kind,
        input: input.id ? { id: input.id } : input.text ? { text: input.text } : {},
      });
      if (kind === 'todos' && value !== null && !('items' in value)) {
        const packFacts = service.packs().flatMap(
          (pack) =>
            pack
              .snapshotRows?.([], Date.now(), [input.id ?? ''])
              .filter((row) => row.todoId === input.id)
              .map((row) => ({ pack: pack.id, ...row })) ?? []
        );
        return result({ ...value, packFacts });
      }
      return result(value);
    })
  );
  const replyFields = {
    requestId: NeoPublicationDraft.shape.requestId,
    replyTo: z
      .array(z.uuid())
      .max(100)
      .optional()
      .describe(
        'The human message IDs this answers. Omit only for a message that answers no human message.'
      ),
    artifacts: NeoPublicationDraft.shape.artifacts,
    session: NeoPublicationDraft.shape.session,
    links: NeoPublicationDraft.shape.links,
    spoken: NeoPublicationDraft.shape.spoken.describe(
      "Required while the latest fact is [listening: yes]: one or two natural spoken lines in the human's language, consistent with the text, without paths, IDs, hashes, long numbers or Markdown. Omit when [listening: no]."
    ),
  };
  const publish = async (input: z.infer<typeof NeoPublicationDraft> & { replyTo?: string[] }) => {
    const replyTo = input.replyTo ?? [];
    if (
      !input.progress &&
      replyTo.some(
        (id) => !service.publications.get(conversationId, frontProgressId(conversationId, [id]))
      )
    )
      return result({ accepted: false, reason: 'front_ack_required' });
    if (!input.spoken && service.speech.isListening(service.defaultSessionId() ?? sessionId))
      return result({ accepted: false, reason: 'spoken_required', listening: 'yes' });
    return result(await service.publish({ ...input, replyTo }, { source: 'mcp', sessionId }));
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
        'Send one plain message with no Details. Use for at most five short sentences in one brief paragraph. Use for acknowledgments, brief answers and progress updates. First call this with progress:true and the human replyTo ID for a one-sentence acknowledgment before doing work. For a final short answer omit progress. While [listening: yes], include spoken.',
        {
          ...replyFields,
          text: z.string().trim().min(1).max(16000),
          progress: z.literal(true).optional(),
        },
        async ({ text, ...input }) => publish({ ...input, fullText: text, verbatim: true })
      ),
      tool(
        'reply_detailed',
        'Use for more than five sentences or any structured report, multi-topic update, list, table or long report. Provide a standalone summary and additional details. Details must add information beyond the summary. Give the human replyTo IDs it answers. Start the conversation with reply_short, then use this for the full answer. While [listening: yes], include spoken.',
        {
          ...replyFields,
          summary: z.string().trim().min(1).max(2000),
          details: z.string().trim().min(1).max(16000),
        },
        async ({ summary, details, ...input }) =>
          publish({ ...input, shortText: summary, fullText: details })
      ),
      tool(
        'work_on',
        'For anything you cannot answer from your reads (check, search, change or run), call this with the human message IDs. It takes a while. When it is done, the answer goes to the human by itself, and you will see it in <already-said> on your next turn.',
        {
          requestId: z.string().min(1).max(160),
          messageIds: z.array(z.uuid()).min(1).max(100),
        },
        async ({ messageIds }) => {
          const asks = messageIds.map((id) => service.asks.find(conversationId, id));
          if (asks.some((ask) => !ask))
            return result({ started: false, reason: 'unknown_reply_target' });
          if (
            service.repo.readConversationId() !== conversationId ||
            service.db.getGlobalSettings().neo?.front?.enabled !== true
          )
            return result({ started: false, reason: 'front_not_speaking' });
          if (
            messageIds.some(
              (id) =>
                !service.publications.get(conversationId, frontProgressId(conversationId, [id]))
            )
          )
            return result({ started: false, reason: 'front_ack_required' });
          const prompts = asks.flatMap((ask) =>
            ask
              ? [
                  {
                    sessionId: ask.askOrigin.sessionId,
                    message: neoIntakeMessage(
                      { ...ask, sessionId: ask.askOrigin.sessionId },
                      ask.askOrigin.sessionId,
                      readNeoReply(ask.replyTo, service.todos),
                      null,
                      undefined,
                      ask.previewContext ?? null
                    ),
                  },
                ]
              : []
          );
          const reserved = await service.db.gateway.call(
            neoFrontInputWrites,
            'reserve',
            conversationId,
            messageIds,
            prompts
          );
          return result(
            reserved === 'reserved'
              ? { started: true }
              : {
                  started: false,
                  reason: reserved === 'handed_off' ? 'input_handed_off' : 'delivery_failed',
                }
          );
        }
      ),
    ],
  });
}
