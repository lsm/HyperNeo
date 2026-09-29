import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { projectNeoWorkReply } from './work-reply.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { NeoMessage } from './NeoMessage.tsx';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';
import { projectNeoReplyContext } from './reply-context.ts';
import {
  neoRequestOrigin,
  neoRequestConsultationProgress,
  projectNeoRequestSnapshot,
} from './request-board.ts';
import { NeoConcernBoardPanel } from './NeoConcernBoard.tsx';
import { connectionState } from '../lib/state.ts';
import { projectNeoProcessingActivity } from './processing-activity.ts';

export function conversationText(message: ChatMessage): string {
  if (message.type !== 'assistant' && message.type !== 'user') return '';
  if (message.parent_tool_use_id) return '';
  const content = message.message.content;
  if (typeof content === 'string') return content;
  return (content as unknown[])
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const item = block as { type?: string; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    })
    .join('\n\n');
}

export function completedConversation(messages: ChatMessage[]): ChatMessage[] {
  const visible: ChatMessage[] = [];
  let reply: ChatMessage | null = null;
  for (const message of messages) {
    const text = conversationText(message);
    const syntheticDelivery = (message as { inputKind?: string }).inputKind === 'system';
    if (message.type === 'user' && text && !syntheticDelivery) visible.push(message);
    if (message.type === 'assistant' && text) reply = message;
    if (message.type === 'result') {
      if (reply) visible.push(reply);
      reply = null;
    }
  }
  return visible;
}

export function completedWorkReplies(
  messages: ChatMessage[],
  works: NeoWork[],
  sessionId = ''
): Map<string, NeoWork> {
  const receipts = new Map<string, NeoWork>();
  for (const work of works) {
    if (!work.report) continue;
    receipts.set(work.id, work);
    receipts.set(`neo-consult:neo-work:${work.id}:review:reply`, work);
  }
  const replies = new Map<string, NeoWork>();
  let active: NeoWork | null = null;
  let reply: ChatMessage | null = null;
  for (const message of messages) {
    if (message.type === 'user' && !message.parent_tool_use_id) {
      active =
        (message as { inputKind?: string }).inputKind === 'system'
          ? (receipts.get(message.uuid ?? '') ?? null)
          : null;
    }
    if (message.type === 'assistant' && conversationText(message)) reply = message;
    if (message.type === 'result') {
      if (active && reply?.uuid) replies.set(reply.uuid, active);
      active = null;
      reply = null;
    }
  }
  for (const message of completedConversation(messages)) {
    const linked = projectNeoWorkReply(message, sessionId, receipts);
    if (linked === 'legacy') continue;
    if (message.uuid) replies.delete(message.uuid);
    if (typeof linked === 'object') replies.set(linked.replyId, linked.work);
  }
  return replies;
}

export function NeoConversation({
  store,
  sessionId,
  works = [],
  snapshot = null,
}: {
  store: SessionStore;
  sessionId: string;
  works?: NeoWork[];
  snapshot?: NeoSnapshot | null;
}) {
  const messages = store.sdkMessages.value;
  const maps = useMessageMaps(messages, sessionId);
  const state = store.agentState.value;
  const pending = state.status === 'waiting_for_input' ? state.pendingQuestion : null;
  const conversation = messages.filter(
    (message) => !maps.replacementStatusMap.has(message.uuid ?? '')
  );
  const visible = completedConversation(conversation);
  const workReplies = completedWorkReplies(conversation, works, sessionId);
  const progress = projectNeoProcessingActivity(
    sessionId,
    store.activeSessionId?.value ?? null,
    store.sessionState?.value ?? null,
    state,
    connectionState.value === 'connected',
    store.isRecovering?.value ?? true,
    visible
  );
  const renderProgress = (label: string) => (
    <div role="status" class="neo-progress" aria-live="polite">
      <span class="neo-progress-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  );
  return (
    <>
      <section aria-label="Conversation with Neo" class="space-y-6">
        {store.hasMoreMessages.value && (
          <p class="text-xs text-fg-muted">
            Showing recent conversation.{' '}
            <a
              class="text-accent hover:underline"
              href={`/session/${sessionId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open full history ↗
            </a>
          </p>
        )}
        {visible.map((message) => {
          const context = projectNeoReplyContext(message, sessionId, visible, conversationText);
          const requestOrigin = neoRequestOrigin(message, sessionId);
          const checks =
            message.type === 'user' && requestOrigin
              ? neoRequestConsultationProgress(projectNeoRequestSnapshot(snapshot, requestOrigin))
              : [];
          const askProgress =
            progress !== 'inactive' &&
            message.type === 'user' &&
            progress.messageId === message.uuid;
          return (
            <NeoMessage
              key={message.uuid}
              message={message}
              text={conversationText(message)}
              work={workReplies.get(message.uuid ?? '')}
              sessionId={sessionId}
              replyTo={typeof context === 'object' ? context : undefined}
            >
              {checks.map((check) => (
                <p
                  key={check.id}
                  role="status"
                  aria-live="polite"
                  class="mt-2 flex items-center justify-end gap-2 text-xs text-fg-muted"
                >
                  {check.status === 'pending' && (
                    <span class="neo-progress-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {check.label}
                </p>
              ))}
              {askProgress && renderProgress(progress.label)}
              {requestOrigin && snapshot && (
                <NeoConcernBoardPanel
                  snapshot={snapshot}
                  concernId={null}
                  requestOrigin={requestOrigin}
                />
              )}
            </NeoMessage>
          );
        })}
        {progress !== 'inactive' && !progress.messageId && renderProgress(progress.label)}
        {pending && (
          <QuestionPrompt
            pendingHeading="A quick choice"
            key={pending.toolUseId}
            sessionId={sessionId}
            pendingQuestion={pending}
            onResolved={() => void store.refresh()}
          />
        )}
        {store.error.value && (
          <p
            role="alert"
            class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
          >
            {store.error.value.message}
          </p>
        )}
      </section>
    </>
  );
}
