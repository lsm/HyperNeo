import { useEffect, useState } from 'preact/hooks';
import { Modal } from './ui/Modal.tsx';

export interface QueuePreviewMessage {
  dbId: string;
  uuid: string;
  timestamp: number;
  status: 'enqueued' | 'deferred' | 'consumed';
  text: string;
}

const MAX_PREVIEW_ROWS = 3;
const QUEUE_MODAL_PAGE_SIZE = 10;

interface QueuePreviewRowProps {
  label: 'Steer' | 'Next';
  messages: QueuePreviewMessage[];
  tone: 'current' | 'next';
  testId: string;
  onDeferMessage?: (message: QueuePreviewMessage) => void;
  onPromoteMessage?: (message: QueuePreviewMessage) => void;
  onRemoveMessage?: (message: QueuePreviewMessage) => void;
  onShowAll?: () => void;
}

interface QueuePreviewTrayProps {
  currentTurnMessages: QueuePreviewMessage[];
  nextTurnMessages: QueuePreviewMessage[];
  currentTurnTotal?: number;
  nextTurnTotal?: number;
  className?: string;
  onDeferMessage?: (message: QueuePreviewMessage) => void;
  onPromoteMessage?: (message: QueuePreviewMessage) => void;
  onRemoveMessage?: (message: QueuePreviewMessage) => void;
}

function TrashIcon() {
  return (
    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2}>
      <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M8 6V4h8v2" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M6.5 6l1 16h9l1-16" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6M14 11v6" />
    </svg>
  );
}

function MoveToSteerIcon() {
  return (
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={2.3}
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 12l7-7 7 7" />
    </svg>
  );
}

function MoveToNextIcon() {
  return (
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={2.3}
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M19 12l-7 7-7-7" />
    </svg>
  );
}

function QueuePreviewRow({
  label,
  messages,
  tone,
  testId,
  onDeferMessage,
  onPromoteMessage,
  onRemoveMessage,
  onShowAll,
}: QueuePreviewRowProps) {
  if (messages.length === 0) return null;

  const overflowCount = onShowAll ? Math.max(0, messages.length - MAX_PREVIEW_ROWS) : 0;
  const visibleMessages = overflowCount > 0 ? messages.slice(0, MAX_PREVIEW_ROWS) : messages;

  const toneClasses =
    tone === 'current'
      ? {
          pill: 'border-warning/30 bg-warning/10 text-warning-soft',
          dot: 'bg-warning',
          pillAction:
            'hover:border-amber-400/50 hover:bg-warning/15 hover:text-warning-soft focus-visible:ring-amber-400/60',
        }
      : {
          pill: 'border-accent/30 bg-accent/10 text-accent-soft',
          dot: 'bg-blue-300',
          pillAction:
            'hover:border-blue-400/50 hover:bg-accent/15 hover:text-accent-soft focus-visible:ring-accent/60',
        };

  return (
    <div
      class="space-y-1 px-2 py-2"
      data-testid={testId}
      aria-label={`${label}: ${messages.length} queued ${messages.length === 1 ? 'message' : 'messages'}`}
    >
      {visibleMessages.map((queued) => (
        <div
          key={queued.dbId}
          class="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-fill-soft"
        >
          {tone === 'current' && onDeferMessage ? (
            <button
              type="button"
              class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 ${toneClasses.pill} ${toneClasses.pillAction}`}
              title="Move to Next"
              aria-label={`Move queued message to Next: ${queued.text}`}
              data-testid="defer-queued-message"
              onClick={() => onDeferMessage(queued)}
            >
              <span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
              <span>{label}</span>
              <MoveToNextIcon />
            </button>
          ) : tone === 'next' && onPromoteMessage ? (
            <button
              type="button"
              class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 ${toneClasses.pill} ${toneClasses.pillAction}`}
              title="Move to Steer"
              aria-label={`Move queued message to Steer: ${queued.text}`}
              data-testid="promote-queued-message"
              onClick={() => onPromoteMessage(queued)}
            >
              <span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
              <span>{label}</span>
              <MoveToSteerIcon />
            </button>
          ) : (
            <div
              class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide ${toneClasses.pill}`}
            >
              <span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
              <span>{label}</span>
            </div>
          )}
          <p class="min-w-0 flex-1 truncate text-xs leading-5 text-fg-soft" title={queued.text}>
            {queued.text}
          </p>
          <div class="flex shrink-0 items-center gap-1">
            {onRemoveMessage && (
              <button
                type="button"
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-danger/15 hover:text-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
                title="Delete"
                aria-label={`Delete queued message: ${queued.text}`}
                data-testid="remove-queued-message"
                onClick={() => onRemoveMessage(queued)}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
      ))}
      {overflowCount > 0 && onShowAll && (
        <button
          type="button"
          class="ml-1 mt-0.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          data-testid="queued-show-all"
          aria-label={`Show all ${messages.length} ${label} queued messages`}
          onClick={onShowAll}
        >
          +{overflowCount} more
        </button>
      )}
    </div>
  );
}

export function QueuePreviewTray({
  currentTurnMessages,
  nextTurnMessages,
  currentTurnTotal,
  nextTurnTotal,
  className = '',
  onDeferMessage,
  onPromoteMessage,
  onRemoveMessage,
}: QueuePreviewTrayProps) {
  const [modalGroup, setModalGroup] = useState<'current' | 'next' | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (modalGroup === null) return;
    const empty =
      modalGroup === 'current' ? currentTurnMessages.length === 0 : nextTurnMessages.length === 0;
    if (empty) setModalGroup(null);
  }, [modalGroup, currentTurnMessages.length, nextTurnMessages.length]);

  if (currentTurnMessages.length === 0 && nextTurnMessages.length === 0) {
    return null;
  }

  const modalMessages =
    modalGroup === 'current' ? currentTurnMessages : modalGroup === 'next' ? nextTurnMessages : [];
  const modalTotal =
    modalGroup === 'current' ? currentTurnTotal : modalGroup === 'next' ? nextTurnTotal : undefined;
  const unloaded = Math.max(0, (modalTotal ?? modalMessages.length) - modalMessages.length);
  const totalPages = Math.max(1, Math.ceil(modalMessages.length / QUEUE_MODAL_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageMessages = modalMessages.slice(
    currentPage * QUEUE_MODAL_PAGE_SIZE,
    (currentPage + 1) * QUEUE_MODAL_PAGE_SIZE
  );

  const openModal = (group: 'current' | 'next') => {
    setPage(0);
    setModalGroup(group);
  };

  const isModalOpen = modalGroup !== null && modalMessages.length > 0;

  return (
    <div class={className} data-testid="queue-overlay" aria-live="polite">
      <div class="overflow-hidden rounded-xl border border-line/80 bg-surface/90 shadow-lg shadow-black/20 backdrop-blur-md">
        <div class="divide-y divide-line/90">
          <QueuePreviewRow
            label="Steer"
            messages={currentTurnMessages}
            tone="current"
            testId="queued-current-turn-bubble"
            onDeferMessage={onDeferMessage}
            onPromoteMessage={onPromoteMessage}
            onRemoveMessage={onRemoveMessage}
            onShowAll={() => openModal('current')}
          />
          <QueuePreviewRow
            label="Next"
            messages={nextTurnMessages}
            tone="next"
            testId="queued-next-turn-bubble"
            onDeferMessage={onDeferMessage}
            onPromoteMessage={onPromoteMessage}
            onRemoveMessage={onRemoveMessage}
            onShowAll={() => openModal('next')}
          />
        </div>
      </div>

      {isModalOpen && (
        <Modal
          isOpen
          onClose={() => setModalGroup(null)}
          title={`${modalGroup === 'current' ? 'Steer' : 'Next'} queue — ${
            modalTotal ?? modalMessages.length
          } ${(modalTotal ?? modalMessages.length) === 1 ? 'message' : 'messages'}`}
          size="lg"
        >
          {unloaded > 0 && (
            <p class="mb-2 text-xs text-fg-muted" data-testid="queued-modal-unloaded-note">
              Showing the first {modalMessages.length} queued messages ({unloaded} more not loaded).
            </p>
          )}
          <QueuePreviewRow
            label={modalGroup === 'current' ? 'Steer' : 'Next'}
            messages={pageMessages}
            tone={modalGroup === 'current' ? 'current' : 'next'}
            testId="queued-modal-list"
            onDeferMessage={onDeferMessage}
            onPromoteMessage={onPromoteMessage}
            onRemoveMessage={onRemoveMessage}
          />
          {totalPages > 1 && (
            <div class="mt-3 flex items-center justify-between border-t border-surface-raised pt-3">
              <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-xs text-fg-soft transition-colors hover:bg-fill-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={currentPage === 0}
                data-testid="queued-modal-prev-page"
                onClick={() => setPage(Math.max(0, currentPage - 1))}
              >
                Previous
              </button>
              <span class="text-xs text-fg-muted" data-testid="queued-modal-page-label">
                Page {currentPage + 1} of {totalPages}
              </span>
              <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-xs text-fg-soft transition-colors hover:bg-fill-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={currentPage >= totalPages - 1}
                data-testid="queued-modal-next-page"
                onClick={() => setPage(Math.min(totalPages - 1, currentPage + 1))}
              >
                Next
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
