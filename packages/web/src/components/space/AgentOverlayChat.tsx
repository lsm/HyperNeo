import { useEffect, useRef } from 'preact/hooks';
import type { MessageDeliveryMode, MessageImage } from '@hyperneo/shared';
import { Portal } from '../ui/Portal';
import { setupFocusTrap } from '../ui/Modal';
import { VoiceRecordingIndicator } from '../voice/VoiceRecordingIndicator.tsx';
import { VoiceSurfaceContext } from '../../hooks/useVoiceRecorder';
import ChatContainer from '../../islands/ChatContainer';
import { SessionStore } from '../../lib/session-store';
import type { SpaceOverlayTaskContext } from '../../lib/signals';
import { currentSpaceCanonicalIdSignal, currentSpaceIdSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';

interface AgentOverlayChatProps {
  sessionId?: string;
  agentName?: string;
  highlightMessageId?: string;
  onClose: () => void;
  pendingAgent?: { taskId: string; agentName: string } | null;
  taskContext?: SpaceOverlayTaskContext | null;
}

export function AgentOverlayChat({
  sessionId,
  agentName,
  highlightMessageId,
  onClose,
  pendingAgent,
  taskContext,
}: AgentOverlayChatProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const storeRef = useRef<SessionStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new SessionStore();
  }
  useEffect(() => {
    const store = storeRef.current;
    return () => {
      store?.destroy().catch(() => {});
    };
  }, []);
  const handleTaskContextSend = taskContext
    ? async (message: string, images?: MessageImage[], deliveryMode?: MessageDeliveryMode) => {
        const trimmed = message.trim();
        if (!trimmed) return false;
        const result = await spaceStore.sendTaskMessage(
          taskContext.taskId,
          trimmed,
          {
            kind: 'node_agent',
            agentName: taskContext.agentName,
            ...(taskContext.nodeExecutionId
              ? { nodeExecutionId: taskContext.nodeExecutionId }
              : {}),
            ...(taskContext.workflowNodeId ? { workflowNodeId: taskContext.workflowNodeId } : {}),
            ...(taskContext.sessionId ? { sessionId: taskContext.sessionId } : {}),
          },
          images,
          deliveryMode
        );
        if (result?.delivered === false && !result?.queued) {
          throw new Error(
            'Agent is starting — your message could not be delivered. Try again in a moment.'
          );
        }
        return true;
      }
    : undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (panelRef.current) {
      return setupFocusTrap(panelRef.current);
    }
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let currentDx = 0;

    const CLOSE_THRESHOLD = 80;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      currentDx = 0;
      dragging = true;
      panel.style.transition = 'none';
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!dragging) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (dx > 0 && Math.abs(dx) > Math.abs(dy)) {
        currentDx = dx;
        panel.style.transform = `translateX(${dx}px)`;
        e.preventDefault();
      }
    };

    const finish = () => {
      if (!dragging) return;
      dragging = false;
      if (currentDx > CLOSE_THRESHOLD) {
        panel.style.transition = 'transform 200ms ease-out';
        panel.style.transform = 'translateX(100%)';
        setTimeout(onClose, 200);
      } else {
        panel.style.transition = 'transform 200ms ease-out';
        panel.style.transform = '';
        const tid = setTimeout(() => {
          panel.style.transition = '';
          panel.style.transform = '';
        }, 200);
        return () => clearTimeout(tid);
      }
      currentDx = 0;
    };

    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    panel.addEventListener('touchmove', onTouchMove, { passive: false });
    panel.addEventListener('touchend', finish, { passive: true });
    panel.addEventListener('touchcancel', finish, { passive: true });

    return () => {
      panel.removeEventListener('touchstart', onTouchStart);
      panel.removeEventListener('touchmove', onTouchMove);
      panel.removeEventListener('touchend', finish);
      panel.removeEventListener('touchcancel', finish);
    };
  }, [onClose]);

  const voiceSurfaceSpaceId = currentSpaceCanonicalIdSignal.value ?? currentSpaceIdSignal.value;

  return (
    <Portal into="body">
      <VoiceSurfaceContext.Provider
        value={{
          surfaceId: 'agent-overlay',
          spaceId: voiceSurfaceSpaceId,
          taskId: taskContext?.taskId ?? null,
        }}
      >
        <div
          class="fixed inset-0 z-50 flex justify-end"
          data-testid="agent-overlay-chat"
          aria-modal="true"
          role="dialog"
          aria-label={agentName ? `${agentName} chat` : 'Agent chat'}
        >
          <div
            class="absolute inset-0 bg-black/40 backdrop-blur-[1px] cursor-pointer"
            onClick={onClose}
            aria-hidden="true"
          />

          <div
            ref={panelRef}
            class={cn(
              'relative flex flex-col h-full w-full max-w-2xl bg-dark-900 shadow-2xl',
              'border-l border-dark-700',
              'animate-slideInRight'
            )}
          >
            <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
              <ChatContainer
                key={sessionId ?? `pending:${pendingAgent?.taskId}:${pendingAgent?.agentName}`}
                sessionId={sessionId ?? ''}
                onBack={onClose}
                highlightMessageId={highlightMessageId}
                pendingAgent={pendingAgent ?? null}
                onSendOverride={handleTaskContextSend}
                store={storeRef.current ?? undefined}
                readonly={(taskContext?.readonly ?? false) && !pendingAgent}
              />
            </div>

            <VoiceRecordingIndicator inOverlay />
          </div>
        </div>
      </VoiceSurfaceContext.Provider>
    </Portal>
  );
}
