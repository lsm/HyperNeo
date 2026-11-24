import { ChatErrorMessage, type ChatErrorDetails } from '../components/ChatErrorMessage.tsx';
import type { NeoCardReply } from '@hyperneo/shared/types/neo-publication';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SessionStore } from '../lib/session-store.ts';
import { QuestionPrompt } from '../components/QuestionPrompt.tsx';
import { connectionState } from '../lib/state.ts';
import type { NeoPendingAsk, NeoQuote } from './neo-intake.ts';
import { projectNeoMessageStatuses } from './message-status.ts';
import {
  type NeoEditUndelivered,
  type NeoRetryUndelivered,
  NeoPublicConversation,
  type NeoSessionMute,
  PendingAsk,
} from './NeoPublicConversation.tsx';
import type { NeoPublicConversation as PublicConversation } from './public-conversation.ts';

type QuestionEpoch = Readonly<{ store: SessionStore; sessionId: string; toolUseId: string }>;
type QuestionFailure = { epoch: QuestionEpoch; message: string };

export function NeoConversation({
  store,
  sessionId,
  publicConversation,
  onRetryPublic,
  onLoadEarlierPublic,
  replyLabels,
  pendingAsks,
  onRetryAsk,
  onEditAsk,
  onEditUndelivered,
  onRetryUndelivered,
  mute,
  onQuote,
  onOpenWork,
  onOpenSession,
}: {
  store: SessionStore;
  onQuote?: (quote: NeoQuote) => void;
  onOpenWork?: (anchor: string, cardReply?: NeoCardReply) => void;
  onOpenSession?: (link: string, label: string) => void;
  mute?: NeoSessionMute;
  onEditUndelivered?: NeoEditUndelivered;
  onRetryUndelivered?: NeoRetryUndelivered;
  pendingAsks?: readonly NeoPendingAsk[];
  onRetryAsk?: (requestId: string) => void;
  onEditAsk?: (requestId: string) => void;
  replyLabels?: ReadonlyMap<string, { label: string; askId: string }>;
  sessionId: string;
  publicConversation?: PublicConversation;
  onRetryPublic?: () => void;
  onLoadEarlierPublic?: () => void;
}) {
  const sentHere = useMemo(() => new Set<string>(), [sessionId]);
  pendingAsks?.forEach((ask) => sentHere.add(ask.requestId));
  const state = store.agentState.value;
  const error = store.error.value;
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
  const statuses = publicConversation
    ? projectNeoMessageStatuses(publicConversation.entries, {
        connected: connectionState.value === 'connected',
        status: publicConversation.status,
      })
    : undefined;
  return (
    <>
      <section aria-label="Conversation with Neo" class="space-y-6">
        {publicConversation && (
          <NeoPublicConversation
            conversation={publicConversation}
            skipArrival={sentHere}
            statuses={statuses}
            replyLabels={replyLabels}
            onRetry={onRetryPublic}
            onLoadEarlier={onLoadEarlierPublic}
            onEditUndelivered={onEditUndelivered}
            onRetryUndelivered={onRetryUndelivered}
            mute={mute}
            onQuote={onQuote}
            onOpenWork={onOpenWork}
            onOpenSession={onOpenSession}
          />
        )}
        {pendingAsks
          ?.filter(
            (ask) =>
              !publicConversation?.entries.some(
                (entry) => entry.kind === 'ask' && entry.ask.requestId === ask.requestId
              )
          )
          .map((ask) => (
            <PendingAsk key={ask.requestId} ask={ask} onRetry={onRetryAsk} onEdit={onEditAsk} />
          ))}
        {pending && epoch && (
          <QuestionPrompt
            pendingHeading="A quick choice"
            skin="neo"
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
        {error && (
          <div
            role="alert"
            class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
          >
            <ChatErrorMessage message={error.message} details={error.details as ChatErrorDetails} />
          </div>
        )}
        {replyError && (
          <div
            role="alert"
            class="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
          >
            <ChatErrorMessage message={replyError} />
          </div>
        )}
      </section>
    </>
  );
}
