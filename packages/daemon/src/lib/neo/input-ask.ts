import type { NeoReplyTo } from '@hyperneo/shared/types/neo-ask';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { readNeoReply } from './intake.ts';

export type NeoInputReads = {
  input(caller: OperationCaller, id: string): NeoConversationAsk | null;
  publication(id: string): NeoPublication | null;
};

export const noNeoInputReads: NeoInputReads = { input: () => null, publication: () => null };

type Binding =
  | { value: { askId: string; records: string[] } }
  | { reason: { ok: false; reason: string } };

const words = (content: NeoConversationAsk['content']) =>
  typeof content === 'string'
    ? content
    : content
        .flatMap((block: { type: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
        .join('\n');

function repliedAskId(
  store: NeoAskTodoRepository,
  reads: NeoInputReads,
  sessionId: string,
  replyTo: NeoReplyTo
): string | null {
  if (replyTo.kind !== 'message') return readNeoReply(replyTo, store)?.ask?.id ?? null;
  if (replyTo.author === 'user') return store.findAsk(sessionId, replyTo.id, null)?.id ?? null;
  const told = reads.publication(replyTo.id);
  const origin =
    told?.askOrigin && store.findAsk(told.askOrigin.sessionId, told.askOrigin.messageId, null);
  return told?.cardReply?.askId ?? origin?.id ?? null;
}

export function resolveNeoInputAsk(
  store: NeoAskTodoRepository,
  reads: NeoInputReads,
  caller: OperationCaller,
  request: { input?: string; askId?: string },
  title: string
): Binding {
  if (!request.input)
    return request.askId
      ? { value: { askId: request.askId, records: [] } }
      : {
          reason: {
            ok: false,
            reason:
              'input_required: pass input, the [message id] of the human message this serves.',
          },
        };
  const human = reads.input(caller, request.input);
  if (!human)
    return {
      reason: {
        ok: false,
        reason: `unknown_input: ${request.input} is not a human message you received.`,
      },
    };
  const { sessionId, messageId } = human.askOrigin;
  const askId =
    (human.replyTo && repliedAskId(store, reads, sessionId, human.replyTo)) ??
    store.findAsk(sessionId, messageId, null)?.id ??
    store.openAsk({
      id: crypto.randomUUID(),
      projectId: null,
      goalId: null,
      sessionId,
      originMessageId: messageId,
      title:
        title
          .split('\n')[0]
          .replace(/^[#*\s]+|\*+/g, '')
          .slice(0, 120) || title,
      request: words(human.content) || title,
      createdAt: Date.now(),
    }).id;
  const records =
    request.askId && request.askId !== askId
      ? [
          `ask_rebound: human input ${request.input} belongs to ask ${askId}, not ${request.askId}; used ${askId}.`,
        ]
      : [];
  return { value: { askId, records } };
}
