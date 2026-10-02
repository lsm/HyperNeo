import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPublicationLink } from '@hyperneo/shared/types/neo-publication';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { neoMessageImageSources } from './neo-message-images.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { useMessageMaps } from '../hooks/useMessageMaps.ts';
import { connectionState } from '../lib/state.ts';
import { projectNeoProcessingActivity } from './processing-activity.ts';
import { NeoPublicConversation } from './NeoPublicConversation.tsx';
import type { NeoPublicConversation as PublicConversation } from './public-conversation.ts';

type QuestionEpoch = Readonly<{ store: SessionStore; sessionId: string; toolUseId: string }>;
type QuestionFailure = { epoch: QuestionEpoch; message: string };

export function publicConcernSession(
  ref: Pick<NeoPublicationLink, 'kind' | 'id'>,
  snapshot: NeoSnapshot | null,
  authors?: ReadonlyMap<string, string>
): string | null {
  if (ref.kind !== 'concern' || !snapshot?.concerns.some((item) => item.id === ref.id)) return null;
  const binding = snapshot.publicAuthorBindings?.find(
    (item) => item.kind === 'concern' && item.concernId === ref.id
  );
  return binding && authors?.has(binding.sessionId) ? binding.sessionId : null;
}

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

export function NeoConversation({
  store,
  sessionId,
  works = [],
  snapshot = null,
  publicConversation,
  publicAuthors,
  onOpenPublicAuthor,
  onOpenPublicWork,
  publicConsultationIds,
  onOpenPublicConsultation,
  onRetryPublic,
  onLoadEarlierPublic,
}: {
  store: SessionStore;
  sessionId: string;
  works?: NeoWork[];
  snapshot?: NeoSnapshot | null;
  publicConversation?: PublicConversation;
  publicAuthors?: ReadonlyMap<string, string>;
  onOpenPublicAuthor?: (sessionId: string) => void;
  onOpenPublicWork?: (workId: string) => void;
  publicConsultationIds?: ReadonlySet<string>;
  onOpenPublicConsultation?: (consultationId: string) => void;
  onRetryPublic?: () => void;
  onLoadEarlierPublic?: () => void;
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
        {publicConversation && (
          <NeoPublicConversation
            conversation={publicConversation}
            authors={publicAuthors}
            onOpenAuthor={onOpenPublicAuthor}
            canOpenScene={(ref) =>
              ref.kind === 'work'
                ? !!onOpenPublicWork && works.some((work) => work.id === ref.id)
                : ref.kind === 'consultation'
                  ? !!onOpenPublicConsultation && !!publicConsultationIds?.has(ref.id)
                  : !!onOpenPublicAuthor && !!publicConcernSession(ref, snapshot, publicAuthors)
            }
            onOpenScene={(ref) => {
              if (ref.kind === 'work') {
                if (works.some((work) => work.id === ref.id)) onOpenPublicWork?.(ref.id);
                return;
              }
              if (ref.kind === 'consultation') {
                if (publicConsultationIds?.has(ref.id)) onOpenPublicConsultation?.(ref.id);
                return;
              }
              const target = publicConcernSession(ref, snapshot, publicAuthors);
              if (target) onOpenPublicAuthor?.(target);
            }}
            onRetry={onRetryPublic}
            onLoadEarlier={onLoadEarlierPublic}
            snapshot={snapshot}
          />
        )}
        {progress !== 'inactive' &&
          (publicConversation || !progress.messageId) &&
          renderProgress(progress.label)}
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
