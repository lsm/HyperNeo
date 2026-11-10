import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChevronLeftGlyph } from '../icons/common-glyphs.tsx';
import { generateUUID } from '@hyperneo/shared';
import { cn } from '../../lib/utils.ts';
import { replaceOverlayHistory } from '../../lib/space-router.ts';
import { spaceStore } from '../../lib/space-store.ts';

interface PendingAgentChatProps {
  pendingAgent: { taskId: string; agentName: string; workflowNodeId?: string | null };
  onBack?: () => void;
}

export function PendingAgentChat({ pendingAgent, onBack }: PendingAgentChatProps) {
  const [pendingContent, setPendingContent] = useState('');
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  const pendingDraftNonceRef = useRef<string | null>(null);
  const [pendingWaitingForSession, setPendingWaitingForSession] = useState(false);
  const [pendingErrorMessage, setPendingErrorMessage] = useState<string | null>(null);
  const pendingTextareaRef = useRef<HTMLTextAreaElement>(null);

  const taskActivity = spaceStore.taskActivity.value;
  const pendingLiveMember = useMemo(() => {
    const members = taskActivity.get(pendingAgent.taskId) ?? [];
    return members.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.role === pendingAgent.agentName &&
        m.sessionId &&
        m.nodeExecution?.status !== 'cancelled' &&
        m.nodeExecution?.status !== 'pending' &&
        (!pendingAgent.workflowNodeId || m.nodeExecution?.nodeId === pendingAgent.workflowNodeId)
    );
  }, [pendingAgent, taskActivity]);

  useEffect(() => {
    if (pendingLiveMember?.sessionId) {
      replaceOverlayHistory(
        pendingLiveMember.sessionId,
        pendingLiveMember.label || pendingAgent.agentName,
        undefined,
        {
          taskId: pendingAgent.taskId,
          agentName: pendingAgent.agentName,
          sessionId: pendingLiveMember.sessionId,
          ...(pendingLiveMember.nodeExecution?.nodeExecutionId
            ? { nodeExecutionId: pendingLiveMember.nodeExecution.nodeExecutionId }
            : {}),
          ...(pendingAgent.workflowNodeId ? { workflowNodeId: pendingAgent.workflowNodeId } : {}),
        }
      );
    }
  }, [pendingLiveMember, pendingAgent]);

  useEffect(() => {
    pendingTextareaRef.current?.focus();
  }, [pendingAgent]);

  const handlePendingSend = useCallback(async () => {
    const trimmed = pendingContent.trim();
    if (!trimmed || pendingSubmitting) return;
    setPendingSubmitting(true);
    setPendingErrorMessage(null);
    try {
      const clientMessageId = pendingDraftNonceRef.current ?? generateUUID();
      pendingDraftNonceRef.current = clientMessageId;
      const result = await spaceStore.activateTaskNodeAgent(
        pendingAgent.taskId,
        pendingAgent.agentName,
        trimmed,
        pendingAgent.workflowNodeId ?? undefined,
        clientMessageId
      );
      setPendingContent('');
      pendingDraftNonceRef.current = null;
      if (result.sessionId) {
        const matchingLiveMember =
          (spaceStore.taskActivity.value.get(pendingAgent.taskId) ?? []).find(
            (m) =>
              m.kind === 'node_agent' &&
              m.role === pendingAgent.agentName &&
              m.sessionId === result.sessionId
          ) ?? null;
        replaceOverlayHistory(result.sessionId, pendingAgent.agentName, undefined, {
          taskId: pendingAgent.taskId,
          agentName: pendingAgent.agentName,
          sessionId: result.sessionId,
          ...(matchingLiveMember?.nodeExecution?.nodeExecutionId
            ? { nodeExecutionId: matchingLiveMember.nodeExecution.nodeExecutionId }
            : {}),
          ...(pendingAgent.workflowNodeId ? { workflowNodeId: pendingAgent.workflowNodeId } : {}),
        });
      } else {
        setPendingWaitingForSession(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPendingErrorMessage(`Failed to start ${pendingAgent.agentName}: ${msg}`);
    } finally {
      setPendingSubmitting(false);
    }
  }, [pendingAgent, pendingContent, pendingSubmitting]);

  const handlePendingKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handlePendingSend();
      }
    },
    [handlePendingSend]
  );

  return (
    <div
      class="flex-1 flex flex-col bg-app-content overflow-hidden relative"
      data-testid="pending-agent-overlay"
      aria-label={`${pendingAgent.agentName} chat (starting)`}
    >
      <div class="px-4 min-h-[52px] flex-shrink-0 bg-app-content flex items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            class="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised hover:text-fg-soft transition-colors flex-shrink-0"
            aria-label="Back"
          >
            <ChevronLeftGlyph
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            />
          </button>
        )}
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-fg truncate">{pendingAgent.agentName}</div>
          <div class="text-xs text-fg-faint truncate">
            {pendingWaitingForSession ? 'Starting session…' : 'Not started yet'}
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-auto px-4 py-6">
        <div
          class={cn(
            'mx-auto max-w-md text-center text-sm rounded-lg border bg-surface-overlay/60 px-4 py-6',
            'border-line'
          )}
          data-testid="pending-agent-overlay-body"
        >
          {pendingWaitingForSession ? (
            <>
              <div class="mb-3 flex items-center justify-center">
                <div class="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              </div>
              <p class="text-fg-soft font-medium mb-1">Starting {pendingAgent.agentName}…</p>
              <p class="text-fg-faint">
                Your message has been queued. The session will open here as soon as the agent is
                ready.
              </p>
            </>
          ) : (
            <>
              <p class="text-fg-soft font-medium mb-1">
                {pendingAgent.agentName} hasn't started yet
              </p>
              <p class="text-fg-faint">
                Send a message below to start this agent's session. Your first message will be
                delivered when the session is ready.
              </p>
            </>
          )}
        </div>
      </div>

      <div class={cn('flex-shrink-0 border-t bg-app-content px-3 py-3', 'border-line')}>
        {pendingErrorMessage && (
          <p class="mb-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger-soft">
            {pendingErrorMessage}
          </p>
        )}
        <div class="flex gap-2">
          <textarea
            ref={pendingTextareaRef}
            class="flex-1 min-h-[44px] max-h-40 resize-none rounded-md bg-surface-overlay border border-line text-sm text-fg px-3 py-2 placeholder:text-fg-faint focus:outline-none focus:border-accent"
            placeholder={
              pendingWaitingForSession
                ? `Send another message to ${pendingAgent.agentName}…`
                : `Send first message to ${pendingAgent.agentName}…`
            }
            value={pendingContent}
            onInput={(e) => {
              const next = (e.target as HTMLTextAreaElement).value;
              if (next !== pendingContent) pendingDraftNonceRef.current = null;
              setPendingContent(next);
            }}
            onKeyDown={handlePendingKeyDown}
            disabled={pendingSubmitting || pendingWaitingForSession}
            data-testid="pending-agent-overlay-textarea"
            rows={2}
          />
          <button
            type="button"
            onClick={() => void handlePendingSend()}
            disabled={!pendingContent.trim() || pendingSubmitting}
            class={cn(
              'inline-flex items-center justify-center rounded-md px-3 text-sm font-medium transition-colors flex-shrink-0',
              'bg-accent-hover text-accent-fg hover:bg-accent',
              'disabled:bg-fill-strong disabled:text-fg-faint disabled:cursor-not-allowed'
            )}
            data-testid="pending-agent-overlay-send"
          >
            {pendingSubmitting ? 'Starting…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
