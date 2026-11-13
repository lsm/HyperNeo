import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { neoFrontReads } from '../../storage/repositories/neo-front-read-worker.ts';
import { NeoSpeechSay } from './speech.ts';
import { NeoPublicationDraft } from './publication-operation.ts';
import { frontProgressId, frontSessionId } from './front-mode.ts';
import { catchUpBlock } from './front-catch-up.ts';
import type { NeoService } from './service.ts';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { neoIntakeMessage, readNeoReply } from './intake.ts';
import {
  neoFrontInputReads,
  neoFrontInputWrites,
} from '../../storage/repositories/neo-front-input-worker.ts';
import { foldPublicationDetails } from './publication.ts';

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
  const handOff = async (ask: NeoConversationAsk, messageId: string) => {
    const said = service.publications.get(
      conversationId,
      frontProgressId(conversationId, [messageId])
    );
    const message = neoIntakeMessage(
      { ...ask, sessionId: ask.askOrigin.sessionId },
      ask.askOrigin.sessionId,
      readNeoReply(ask.replyTo, service.todos),
      null,
      undefined,
      ask.previewContext ?? null
    );
    const block = said && catchUpBlock([{ replyTo: [messageId], fullText: said.fullText }]);
    const reserved = await service.db.gateway.call(
      neoFrontInputWrites,
      'reserve',
      conversationId,
      [messageId],
      [
        {
          sessionId: ask.askOrigin.sessionId,
          message: block
            ? {
                ...message,
                message: {
                  ...message.message,
                  content: [
                    ...(message.message.content as Exclude<typeof message.message.content, string>),
                    { type: 'text' as const, text: block },
                  ],
                },
              }
            : message,
        },
      ]
    );
    return reserved === 'reserved'
      ? { started: true }
      : {
          started: false,
          reason: reserved === 'handed_off' ? 'input_handed_off' : 'delivery_failed',
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
        'Send one reply per human message. text is the reply; add details only for more than five sentences or any structured report, list, table or multi-topic update, and make them add information beyond text. For anything you cannot answer from your reads (check, search, change or run), set work_on:true: text is then a one-sentence acknowledgment of at most 150 characters with no details, for exactly one replyTo ID, and the work starts in the same call. Its answer reaches the human by itself, and you will see it in <already-said> on your next turn. While [listening: yes], include spoken.',
        {
          ...replyFields,
          text: z.string().trim().min(1).max(16000),
          details: z.string().trim().min(1).max(16000).optional(),
          work_on: z.literal(true).optional(),
        },
        async ({ text, details, work_on, ...input }) => {
          const body = foldPublicationDetails({ text, details });
          if (!work_on && body.details !== undefined && body.text.length > 2000)
            return result({ accepted: false, reason: 'reply_summary_too_long' });
          if (!work_on) return result(await publish({ ...input, ...body }));
          if (details || text.length > 150 || input.replyTo?.length !== 1)
            return result({ accepted: false, reason: 'work_on_brief' });
          const ask = service.asks.find(conversationId, input.replyTo[0]);
          if (!ask) return result({ accepted: false, reason: 'unknown_reply_target' });
          if (
            service.repo.readConversationId() !== conversationId ||
            service.db.getGlobalSettings().neo?.front?.enabled !== true
          )
            return result({ accepted: false, reason: 'front_not_speaking' });
          const owned = (
            await service.db.gateway.call(
              neoFrontInputReads,
              'get',
              conversationId,
              input.replyTo[0]
            )
          )?.owner;
          if (owned === 'front') return result({ accepted: false, reason: 'input_answered' });
          if (owned) return result({ accepted: false, reason: 'input_handed_off' });
          const receipt = await publish({ ...input, text, progress: true });
          if (!receipt.accepted) return result(receipt);
          const handed = await handOff(ask, input.replyTo[0]);
          return result(handed.started ? { ...receipt, ...handed } : handed);
        }
      ),
    ],
  });
}
