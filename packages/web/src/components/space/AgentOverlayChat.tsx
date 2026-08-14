/**
 * AgentOverlayChat — slide-over panel that renders a ChatContainer on top of
 * the current view without replacing it.
 *
 * Triggered by `spaceOverlaySessionIdSignal` (live session) or
 * `spaceOverlayPendingTaskIdSignal` (not-yet-spawned workflow peer).
 * The embedded `ChatContainer` owns the only header; its left-slot back
 * button (opted in via `onBack`) doubles as the overlay dismiss control.
 * Escape and backdrop-click also dismiss for consistency with other modals.
 */

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
  /** Session ID to display inside the overlay. */
  sessionId?: string;
  /**
   * Human-readable label for the agent (e.g. "Task Agent"). Used only on the
   * wrapper dialog's aria-label so screen readers identify which agent is
   * open; the visible title comes from `ChatContainer`'s session title.
   */
  agentName?: string;
  /**
   * Optional message UUID to scroll into view + briefly highlight when the
   * overlay opens. Used when the user opens a session from a specific message
   * (e.g. clicking the "open in session" button on a minimal thread turn) so
   * they land on the message they clicked instead of the session's tail.
   */
  highlightMessageId?: string;
  /** Called when the overlay should be closed. */
  onClose: () => void;
  /**
   * When set, renders a pending agent state (not-yet-spawned workflow peer)
   * inside the overlay instead of a live session. The ChatContainer shows a
   * "Starting…" composer and hands off to the live session when it appears.
   */
  pendingAgent?: { taskId: string; agentName: string } | null;
  /**
   * Workflow task context for live node-agent sessions. When present, composer
   * sends are routed through task messaging so the daemon injects into the
   * existing MCP-enabled workflow sub-session instead of creating a bare session.
   */
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

  // Dedicated SessionStore instance for this overlay. Because the overlay can
  // mount on top of an already-mounted base chat, sharing the process-wide
  // singleton would make the two views fight over one activeSessionId — the
  // overlay's select() would wipe the base chat's transcript, and unmounting
  // the overlay would deselect the base. Owning a separate instance keeps the
  // overlay's subscriptions, messages, errors, and lifecycle fully isolated.
  // Created once per overlay-open and torn down (subscriptions released,
  // registry unregistered) when the overlay closes.
  const storeRef = useRef<SessionStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new SessionStore();
  }
  useEffect(() => {
    const store = storeRef.current;
    return () => {
      // Release only this overlay's subscriptions. Never touches the base
      // chat's singleton. ChatContainer has already called select(null) on
      // unmount; destroy() is idempotent and also drops the registry entry so
      // reconnect refresh stops targeting this instance.
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
            // Carry the node ID so lazy-activation stays scoped to this node
            // if the latched execution is ever cancelled/disappears.
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

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Focus trap — keep keyboard focus inside the panel while it is open
  useEffect(() => {
    if (panelRef.current) {
      return setupFocusTrap(panelRef.current);
    }
  }, []);

  // Swipe-to-close: dragging the panel rightward dismisses it. We also
  // call preventDefault on horizontal touchmove so the browser's native
  // swipe-back gesture (which navigates the underlying page) is suppressed
  // while the user is clearly swiping the overlay away.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let currentDx = 0;

    const CLOSE_THRESHOLD = 80; // px right to commit close

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      currentDx = 0;
      dragging = true;
      // Remove transition so drag follows finger immediately
      panel.style.transition = 'none';
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!dragging) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      // Only track right-ward swipes that are more horizontal than vertical
      if (dx > 0 && Math.abs(dx) > Math.abs(dy)) {
        currentDx = dx;
        panel.style.transform = `translateX(${dx}px)`;
        // Block the browser back-gesture and underlying scroll
        e.preventDefault();
      }
    };

    const finish = () => {
      if (!dragging) return;
      dragging = false;
      if (currentDx > CLOSE_THRESHOLD) {
        // Slide off-screen then close
        panel.style.transition = 'transform 200ms ease-out';
        panel.style.transform = 'translateX(100%)';
        setTimeout(onClose, 200);
      } else {
        // Spring back to original position
        panel.style.transition = 'transform 200ms ease-out';
        panel.style.transform = '';
        // Clean up inline style after animation
        const tid = setTimeout(() => {
          panel.style.transition = '';
          panel.style.transform = '';
        }, 200);
        return () => clearTimeout(tid);
      }
      currentDx = 0;
    };

    panel.addEventListener('touchstart', onTouchStart, { passive: true });
    // passive: false so we can call preventDefault to suppress browser back gesture
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

  // Voice surface identity for composers mounted inside this overlay: the
  // overlay is its own surface (the base composer for the SAME session can
  // still own a recording underneath it), nested in the same Space. A
  // task-context overlay (workflow node agent) scopes recordings to the task
  // so Return reopens the task thread's task-messaging composer.
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
        {/* Full-screen wrapper — backdrop on the left, panel on the right */}
        <div
          class="fixed inset-0 z-50 flex justify-end"
          data-testid="agent-overlay-chat"
          aria-modal="true"
          role="dialog"
          aria-label={agentName ? `${agentName} chat` : 'Agent chat'}
        >
          {/* Translucent backdrop — click to dismiss */}
          <div
            class="absolute inset-0 bg-black/40 backdrop-blur-[1px] cursor-pointer"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Slide-over panel */}
          <div
            ref={panelRef}
            class={cn(
              'relative flex flex-col h-full w-full max-w-2xl bg-dark-900 shadow-2xl',
              'border-l border-dark-700',
              'animate-slideInRight'
            )}
          >
            {/* Chat content — ChatHeader owns the single header; back button replaces the mobile-menu toggle */}
            <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
              <ChatContainer
                key={sessionId ?? `pending:${pendingAgent?.taskId}:${pendingAgent?.agentName}`}
                sessionId={sessionId ?? ''}
                onBack={onClose}
                highlightMessageId={highlightMessageId}
                pendingAgent={pendingAgent ?? null}
                onSendOverride={handleTaskContextSend}
                store={storeRef.current ?? undefined}
                // Read-only only when the terminal-worker path explicitly marks
                // the overlay as history — contextless overlays opened from the
                // feed (Task Agent / Space Agent) stay writable via message.send.
                readonly={(taskContext?.readonly ?? false) && !pendingAgent}
              />
            </div>

            {/* Global recording-elsewhere chip INSIDE the trapped panel:
                setupFocusTrap cycles only this panel's descendants, so the
                chip must live here for keyboard users to reach it. */}
            <VoiceRecordingIndicator inOverlay />
          </div>
        </div>
      </VoiceSurfaceContext.Provider>
    </Portal>
  );
}
