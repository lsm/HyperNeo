import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { projectNeoWorkReply } from './work-reply.ts';
import { neoMessageImageSources } from './neo-message-images.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { NeoMessage } from './NeoMessage.tsx';
import { NeoWorkCard } from './NeoWorkCard.tsx';
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

type QuestionEpoch = Readonly<{ store: SessionStore; sessionId: string; toolUseId: string }>;
type QuestionFailure = { epoch: QuestionEpoch; message: string };

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
    if (
      message.type === 'user' &&
      !message.parent_tool_use_id &&
      (text || neoMessageImageSources(message).length > 0) &&
      !syntheticDelivery
    )
      visible.push(message);
    if (message.type === 'assistant' && text) reply = message;
    if (message.type === 'result') {
      if (reply) visible.push(reply);
      reply = null;
    }
  }
  return visible;
}

export function messageIdSet(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) if (message.uuid) ids.add(message.uuid);
  return ids;
}

export function inlineOriginKey(
  work: NeoWork,
  sessionId: string,
  visible: Set<string>
): string | null {
  const origin = work.originMessageId;
  if (!origin || work.originSessionId !== sessionId) return null;
  return visible.has(origin) ? origin : null;
}

export function inflightWorkByOrigin(
  works: NeoWork[],
  sessionId: string,
  visible: Set<string>
): Map<string, NeoWork[]> {
  const byOrigin = new Map<string, NeoWork[]>();
  for (const work of works) {
    if (work.status !== 'proposed' && work.status !== 'queued') continue;
    const origin = inlineOriginKey(work, sessionId, visible);
    if (!origin) continue;
    const bucket = byOrigin.get(origin) ?? [];
    bucket.push(work);
    byOrigin.set(origin, bucket);
  }
  return byOrigin;
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
  workBusy = null,
  workDisabled = false,
  onWorkAction = () => {},
}: {
  store: SessionStore;
  sessionId: string;
  works?: NeoWork[];
  snapshot?: NeoSnapshot | null;
  workBusy?: string | null;
  workDisabled?: boolean;
  onWorkAction?: (id: string, action: 'start' | 'cancel') => void;
}) {
  const messages = store.sdkMessages.value;
  const maps = useMessageMaps(messages, sessionId);
  const state = store.agentState.value;
  const pending = state.status === 'waiting_for_input' ? state.pendingQuestion : null;
  const epoch = useMemo(
    () => (pending ? Object.freeze({ store, sessionId, toolUseId: pending.toolUseId }) : null),
    [store, sessionId, pending?.toolUseId]
  );
  const currentEpoch = useRef<QuestionEpoch | null>(epoch);
  currentEpoch.current = epoch;
  useEffect(
    () => () => {
      currentEpoch.current = null;
    },
    []
  );
  const [questionFailure, setQuestionFailure] = useState<QuestionFailure | null>(null);
  const isCurrentEpoch = (candidate: QuestionEpoch) => {
    const current = candidate.store.agentState.value;
    return (
      currentEpoch.current === candidate &&
      candidate.store.activeSessionId.value === candidate.sessionId &&
      current.status === 'waiting_for_input' &&
      current.pendingQuestion.toolUseId === candidate.toolUseId
    );
  };
  const replyError =
    pending && epoch && questionFailure?.epoch === epoch ? questionFailure.message : null;
  const conversation = messages.filter(
    (message) => !maps.replacementStatusMap.has(message.uuid ?? '')
  );
  const visible = completedConversation(conversation);
  const workReplies = completedWorkReplies(conversation, works, sessionId);
  const inflight = inflightWorkByOrigin(works, sessionId, messageIdSet(visible));
  const placed = new Set([...inflight.values()].flat().map((work) => work.id));
  const unplaced = works.filter(
    (work) => (work.status === 'proposed' || work.status === 'queued') && !placed.has(work.id)
  );
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
              {(inflight.get(message.uuid ?? '') ?? []).map((work) => (
                <div key={work.id} id={`inline-work-${work.id}`} class="mt-3">
                  <NeoWorkCard
                    work={work}
                    busy={workBusy === work.id}
                    disabled={workDisabled}
                    onAction={onWorkAction}
                  />
                </div>
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
        {unplaced.length > 0 && (
          <section aria-label="Work without a message here" class="mt-6">
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              Work with no message here · {unplaced.length}
            </p>
            {unplaced.map((work) => (
              <div key={work.id} id={`inline-work-${work.id}`} class="mt-3">
                <NeoWorkCard
                  work={work}
                  busy={workBusy === work.id}
                  disabled={workDisabled}
                  onAction={onWorkAction}
                />
              </div>
            ))}
          </section>
        )}
        {progress !== 'inactive' && !progress.messageId && renderProgress(progress.label)}
        {pending && epoch && (
          <QuestionPrompt
            pendingHeading="A quick choice"
            key={`${sessionId}:${pending.toolUseId}`}
            sessionId={sessionId}
            pendingQuestion={pending}
            onResolved={() => {
              if (!isCurrentEpoch(epoch)) return;
              setQuestionFailure(null);
              void epoch.store.refresh();
            }}
            onError={(cause) => {
              if (!isCurrentEpoch(epoch)) return;
              setQuestionFailure({
                epoch,
                message:
                  cause instanceof Error ? cause.message : 'Could not send your choice. Try again.',
              });
            }}
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
        {replyError && (
          <p
            role="alert"
            class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
          >
            {replyError}
          </p>
        )}
      </section>
    </>
  );
}
