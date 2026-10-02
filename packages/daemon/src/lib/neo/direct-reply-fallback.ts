import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';

export type NeoDirectReplyRuntime = {
  getBinding: (sessionId: string) => NeoBinding | null;
  getRootBinding: () => NeoBinding | null;
  newestAsk: (conversationId: string, sessionId: string) => NeoConversationAsk | null;
  isPublished: (sessionId: string, messageId: string) => boolean;
  startedWork: (sessionId: string, messageId: string) => boolean;
  turnEnded: (sessionId: string, messageId: string) => 'open' | 'failed' | 'ended';
  finalText: (sessionId: string, messageId: string) => string | null;
  append: (input: NeoPublicationInput) => { accepted: boolean };
  notify: () => void;
  newId: () => string;
};
type Skip = { skipped: true };
type Gate<T> = { value: T } | { reason: Skip };
type Turn = { sessionId: string; conversationId: string; ask: NeoConversationAsk };
type Reply = Turn & { text: string };

const skip: { reason: Skip } = { reason: { skipped: true } };

export function requireNeoReplySession(
  sessionId: string,
  runtime: NeoDirectReplyRuntime
): Gate<Turn> {
  const binding = runtime.getBinding(sessionId);
  const root = runtime.getRootBinding();
  if (!binding || binding.kind === 'worker' || root?.kind !== 'neo') return skip;
  if (!root.sessionId.startsWith('neo:')) return skip;
  const conversationId = root.sessionId.slice(4);
  const ask = runtime.newestAsk(conversationId, sessionId);
  return ask ? { value: { sessionId, conversationId, ask } } : skip;
}

export function requireUnpublishedDirectAnswer(
  turn: Turn,
  runtime: NeoDirectReplyRuntime
): Gate<Reply> {
  const messageId = turn.ask.requestId;
  if (runtime.turnEnded(turn.sessionId, messageId) !== 'ended') return skip;
  if (runtime.isPublished(turn.sessionId, messageId)) return skip;
  if (runtime.startedWork(turn.sessionId, messageId)) return skip;
  const text = runtime.finalText(turn.sessionId, messageId)?.trim();
  return text ? { value: { ...turn, text } } : skip;
}

function publishDirectReply(
  reply: Reply,
  runtime: NeoDirectReplyRuntime
): Skip | NeoPublicationInput {
  const input: NeoPublicationInput = {
    conversationId: reply.conversationId,
    publicationId: runtime.newId(),
    askOrigin: reply.ask.askOrigin,
    producerInput: { sessionId: reply.sessionId, messageId: reply.ask.requestId },
    shortText: reply.text.length > 2000 ? `${reply.text.slice(0, 1999)}…` : reply.text,
    fullText: reply.text.slice(0, 16000),
    links: [],
  };
  if (!runtime.append(input).accepted) return { skipped: true };
  runtime.notify();
  return input;
}

export const publishNeoDirectReplyFallback = (
  superpipe({})('neo-direct-reply-fallback') as PipelineAPI
)
  .input(['sessionId', 'runtime'])
  .pipe(requireNeoReplySession, ['sessionId', 'runtime'], 'result:reply')
  .pipe(requireUnpublishedDirectAnswer, ['reply', 'runtime'], 'result:reply')
  .pipe(publishDirectReply, ['reply', 'runtime'], 'reply')
  .end('reply') as (
  sessionId: string,
  runtime: NeoDirectReplyRuntime
) => Skip | NeoPublicationInput;
