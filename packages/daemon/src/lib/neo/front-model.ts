import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { NeoSpeechSay } from './speech.ts';
import { NeoPublicationDraft, publicationIdFor } from './publication-operation.ts';
import { frontSessionId } from './front-mode.ts';
import { catchUpBlock } from './front-catch-up.ts';
import type { NeoService } from './service.ts';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import { neoFrontInputWrites } from '../../storage/repositories/neo-front-input-worker.ts';
import { explainNeoRefusal } from '@hyperneo/shared/types/neo-refusals';
import { foldPublicationDetails, replyBodyRefusal } from './publication.ts';

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
    if (!input.spoken && service.speech.isListening(service.defaultSessionId() ?? sessionId))
      return { accepted: false, reason: 'spoken_required', listening: 'yes' };
    return service.publish(
      { ...input, replyTo: input.replyTo ?? [] },
      { source: 'mcp', sessionId }
    );
  };
  const handOff = async (asks: NeoConversationAsk[], messageIds: string[], saidText: string) => {
    const block = catchUpBlock([{ replyTo: messageIds, fullText: saidText }]);
    const reserved = await service.db.gateway.call(
      neoFrontInputWrites,
      'reserve',
      conversationId,
      messageIds,
      asks.map((ask) => {
        const message = neoIntakeMessage(
          { ...ask, sessionId: ask.askOrigin.sessionId },
          ask.askOrigin.sessionId,
          readNeoReply(ask.replyTo, service.todos),
          null,
          undefined,
          ask.previewContext ?? null
        );
        return {
          sessionId: ask.askOrigin.sessionId,
          message: {
            ...message,
            message: {
              ...message.message,
              content: [
                ...(message.message.content as Exclude<typeof message.message.content, string>),
                { type: 'text' as const, text: block },
              ],
            },
          },
        };
      })
    );
    return reserved === 'reserved'
      ? { started: true }
      : {
          started: false,
          reason: reserved === 'ineligible' ? 'unknown_reply_target' : 'delivery_failed',
        };
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
        'reply',
        'Send one reply per human message. text is the reply; add details only for a body over the limit or any structured report, list, table or multi-topic update, and make them add information beyond text. If your reads answer the message, reply with the answer; otherwise say in one brief line what will be done, without claiming it is done. Every message also goes on to be handled in full, so never promise what you cannot check. The reply reaches the human and the full session sees it in <already-said>. While [listening: yes], include spoken.',
        {
          ...replyFields,
          text: z.string().trim().min(1).max(16000),
          details: z.string().trim().min(1).max(16000).optional(),
        },
        async ({ text, details, ...input }) => {
          const body = foldPublicationDetails({ text, details });
          const refusal = replyBodyRefusal({ text, details });
          if (refusal) return result(explainNeoRefusal({ accepted: false, reason: refusal }));
          const targets = input.replyTo ?? [];
          if (!targets.length) return result(await publish({ ...input, ...body }));
          const asks = targets.map((id) => service.asks.find(conversationId, id));
          if (asks.some((ask) => !ask))
            return result({ accepted: false, reason: 'unknown_reply_target' });
          if (
            service.repo.readConversationId() !== conversationId ||
            service.db.getGlobalSettings().neo?.front?.enabled !== true
          )
            return result({ accepted: false, reason: 'front_not_speaking' });
          const receipt = await publish({ ...input, ...body });
          const second = !receipt.accepted && receipt.reason === 'publication_conflict';
          if (!receipt.accepted && !second) return result(receipt);
          const existing = second
            ? service.publications.get(conversationId, publicationIdFor(sessionId, input.requestId))
            : null;
          if (second && !existing)
            return result({ accepted: false, reason: 'publication_conflict' });
          const said = existing?.fullText ?? body.details ?? body.text;
          const handed = await handOff(
            asks.map((ask) => ask!),
            targets,
            said
          );
          return result(
            handed.started
              ? { ...(receipt.accepted ? receipt : { accepted: true }), ...handed }
              : handed
          );
        }
      ),
    ],
  });
}
