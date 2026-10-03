import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { neoNudgeMessageId } from './ask-origin.ts';

export type NeoTurnReply = {
  status: 'missing' | 'open' | 'failed' | 'ended';
  text: string | null;
};
export type NeoDirectReplyRuntime = {
  getBinding: (sessionId: string) => NeoBinding | null;
  getRootBinding: () => NeoBinding | null;
  recentAsks: (conversationId: string, sessionId: string) => NeoConversationAsk[];
  isPublished: (sessionId: string, messageId: string) => boolean;
  startedWork: (sessionId: string, messageId: string) => boolean;
  turnReply: (sessionId: string, messageId: string) => NeoTurnReply;
  hasNudge: (sessionId: string, nudgeId: string) => boolean;
  nudge: (sessionId: string, nudgeId: string) => void;
  append: (input: NeoPublicationInput) => { accepted: boolean };
  notify: () => void;
  newId: () => string;
};
type Skip = { skipped: true; nudgeId?: string };
type Gate<T> = { value: T } | { reason: Skip };
type Scope = { sessionId: string; conversationId: string };
type Turn = Scope & { ask: NeoConversationAsk; latest?: boolean };
type Reply = Turn & { text: string };

const skip: { reason: Skip } = { reason: { skipped: true } };

export const NEO_UNFINISHED_REPLY = 'I couldn’t finish answering that. Please ask again.';
export const NEO_PUBLISH_NUDGE =
  'Your last turn ended without publishing an answer to the human’s message. Publish your answer to that message now with neo.publication.publish, in the human’s language. Do not start new work.';

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
  const nudgeId = neoNudgeMessageId(messageId);
  for (const id of [messageId, nudgeId])
    if (runtime.isPublished(turn.sessionId, id) || runtime.startedWork(turn.sessionId, id))
      return skip;
  const reply = runtime.turnReply(turn.sessionId, messageId);
  if (reply.status === 'missing') return skip;
  const text = reply.text?.trim();
  if (reply.status === 'ended' && text) return { value: { ...turn, text } };
  if (!runtime.hasNudge(turn.sessionId, nudgeId))
    return turn.latest ? { reason: { skipped: true, nudgeId } } : skip;
  const nudged = runtime.turnReply(turn.sessionId, nudgeId);
  if (nudged.status === 'missing') return skip;
  const nudgedText = nudged.status === 'ended' ? nudged.text?.trim() : null;
  return { value: { ...turn, text: nudgedText || NEO_UNFINISHED_REPLY } };
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
  const asks = runtime.recentAsks(scope.conversationId, sessionId);
  return asks
    .map((ask, index) => publishTurn({ ...scope, ask, latest: index === asks.length - 1 }, runtime))
    .filter((result): result is NeoPublicationInput => {
      if (!('skipped' in result)) return true;
      if (result.nudgeId) runtime.nudge(sessionId, result.nudgeId);
      return false;
    });
}
