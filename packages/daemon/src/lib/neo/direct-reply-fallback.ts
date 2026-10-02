import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';

export type NeoTurnReply = { status: 'open' | 'failed' | 'ended'; text: string | null };
export type NeoDirectReplyRuntime = {
  getBinding: (sessionId: string) => NeoBinding | null;
  getRootBinding: () => NeoBinding | null;
  recentAsks: (conversationId: string, sessionId: string) => NeoConversationAsk[];
  isPublished: (sessionId: string, messageId: string) => boolean;
  startedWork: (sessionId: string, messageId: string) => boolean;
  turnReply: (sessionId: string, messageId: string) => NeoTurnReply;
  append: (input: NeoPublicationInput) => { accepted: boolean };
  notify: () => void;
  newId: () => string;
};
type Skip = { skipped: true };
type Gate<T> = { value: T } | { reason: Skip };
type Scope = { sessionId: string; conversationId: string };
type Turn = Scope & { ask: NeoConversationAsk };
type Reply = Turn & { text: string };

const skip: { reason: Skip } = { reason: { skipped: true } };

export function requireNeoReplySession(
  sessionId: string,
  runtime: NeoDirectReplyRuntime
): Scope | null {
  const binding = runtime.getBinding(sessionId);
  const root = runtime.getRootBinding();
  if (!binding || binding.kind === 'worker' || root?.kind !== 'neo') return null;
  if (!root.sessionId.startsWith('neo:')) return null;
  return { sessionId, conversationId: root.sessionId.slice(4) };
}

export function requireUnpublishedDirectAnswer(
  turn: Turn,
  runtime: NeoDirectReplyRuntime
): Gate<Reply> {
  const messageId = turn.ask.requestId;
  if (runtime.isPublished(turn.sessionId, messageId)) return skip;
  if (runtime.startedWork(turn.sessionId, messageId)) return skip;
  const reply = runtime.turnReply(turn.sessionId, messageId);
  const text = reply.text?.trim();
  return reply.status === 'ended' && text ? { value: { ...turn, text } } : skip;
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

const publishTurn = (superpipe({})('neo-direct-reply-fallback') as PipelineAPI)
  .input(['turn', 'runtime'])
  .pipe(requireUnpublishedDirectAnswer, ['turn', 'runtime'], 'result:reply')
  .pipe(publishDirectReply, ['reply', 'runtime'], 'reply')
  .end('reply') as (turn: Turn, runtime: NeoDirectReplyRuntime) => Skip | NeoPublicationInput;

export function publishNeoDirectReplyFallback(
  sessionId: string,
  runtime: NeoDirectReplyRuntime
): NeoPublicationInput[] {
  const scope = requireNeoReplySession(sessionId, runtime);
  if (!scope) return [];
  return runtime
    .recentAsks(scope.conversationId, sessionId)
    .map((ask) => publishTurn({ ...scope, ask }, runtime))
    .filter((result): result is NeoPublicationInput => !('skipped' in result));
}
