import {
  QueueTrashIcon as TrashIcon,
  QueueMoveToSteerIcon as MoveToSteerIcon,
} from './icons/panel-icons.tsx';
import { useEffect, useState } from 'preact/hooks';
import { Modal } from './ui/Modal.tsx';
import { t } from '../lib/i18n/index.ts';

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
  messages: QueuePreviewMessage[];
  testId: string;
  onPromoteMessage?: (message: QueuePreviewMessage) => void;
  onRemoveMessage?: (message: QueuePreviewMessage) => void;
  onShowAll?: () => void;
}

interface QueuePreviewTrayProps {
  nextTurnMessages: QueuePreviewMessage[];
  nextTurnTotal?: number;
  pendingModel?: string | null;
  onCancelPendingModel?: () => void;
  className?: string;
  onPromoteMessage?: (message: QueuePreviewMessage) => void;
  onRemoveMessage?: (message: QueuePreviewMessage) => void;
}

function QueuePreviewRow({
  messages,
  testId,
  onPromoteMessage,
  onRemoveMessage,
  onShowAll,
}: QueuePreviewRowProps) {
  if (messages.length === 0) return null;

  const overflowCount = onShowAll ? Math.max(0, messages.length - MAX_PREVIEW_ROWS) : 0;
  const visibleMessages = overflowCount > 0 ? messages.slice(0, MAX_PREVIEW_ROWS) : messages;

  const toneClasses = {
    pill: 'border-accent/30 bg-accent/10 text-accent-soft',
    dot: 'bg-blue-300',
    pillAction:
      'hover:border-blue-400/50 hover:bg-accent/15 hover:text-accent-soft focus-visible:ring-accent/60',
  };

  return (
    <div
      class="space-y-1 px-2 py-2"
      data-testid={testId}
      aria-label={`Next: ${messages.length} queued ${messages.length === 1 ? 'message' : 'messages'}`}
    >
      {visibleMessages.map((queued) => (
        <div
          key={queued.dbId}
          class="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-fill-soft"
        >
          {onPromoteMessage ? (
            <button
              type="button"
              class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 ${toneClasses.pill} ${toneClasses.pillAction}`}
              title="Move to Steer"
              aria-label={`Move queued message to Steer: ${queued.text}`}
              data-testid="promote-queued-message"
              onClick={() => onPromoteMessage(queued)}
            >
              <span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
              <span>Next</span>
              <MoveToSteerIcon />
            </button>
          ) : (
            <div
              class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide ${toneClasses.pill}`}
            >
              <span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
              <span>Next</span>
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
          aria-label={`Show all ${messages.length} Next queued messages`}
          onClick={onShowAll}
        >
          +{overflowCount} more
        </button>
      )}
    </div>
  );
}

export function QueuePreviewTray({
  nextTurnMessages,
  nextTurnTotal,
  pendingModel,
  onCancelPendingModel,
  className = '',
  onPromoteMessage,
  onRemoveMessage,
}: QueuePreviewTrayProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (modalOpen && nextTurnMessages.length === 0) setModalOpen(false);
  }, [modalOpen, nextTurnMessages.length]);

  if (nextTurnMessages.length === 0 && !pendingModel) {
    return null;
  }

  const unloaded = Math.max(
    0,
    (nextTurnTotal ?? nextTurnMessages.length) - nextTurnMessages.length
  );
  const totalPages = Math.max(1, Math.ceil(nextTurnMessages.length / QUEUE_MODAL_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageMessages = nextTurnMessages.slice(
    currentPage * QUEUE_MODAL_PAGE_SIZE,
    (currentPage + 1) * QUEUE_MODAL_PAGE_SIZE
  );

  const openModal = () => {
    setPage(0);
    setModalOpen(true);
  };

  const isModalOpen = modalOpen && nextTurnMessages.length > 0;

  return (
    <div class={className} data-testid="queue-overlay" aria-live="polite">
      <div class="overflow-hidden rounded-xl border border-line/80 bg-surface/90 shadow-lg shadow-black/20 backdrop-blur-md">
        <div class="divide-y divide-line/90">
          <QueuePreviewRow
            messages={nextTurnMessages}
            testId="queued-next-turn-bubble"
            onPromoteMessage={onPromoteMessage}
            onRemoveMessage={onRemoveMessage}
            onShowAll={openModal}
          />
          {pendingModel && (
            <div class="px-2 py-2" data-testid="queued-pending-model">
              <div class="flex min-h-8 min-w-0 items-center gap-2 px-1.5 py-1">
                <div class="inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 text-[10px] font-medium uppercase tracking-wide text-accent-soft">
                  <span class="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span>Model</span>
                </div>
                <p
                  class="min-w-0 flex-1 truncate text-xs leading-5 text-fg-soft"
                  title={pendingModel}
                >
                  {pendingModel} · {t('composer.switchesNextTurn')}
                </p>
                {onCancelPendingModel && (
                  <button
                    type="button"
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors hover:bg-danger/15 hover:text-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
                    title="Cancel"
                    aria-label={`Cancel the switch to ${pendingModel}`}
                    data-testid="cancel-pending-model"
                    onClick={onCancelPendingModel}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {isModalOpen && (
        <Modal
          isOpen
          onClose={() => setModalOpen(false)}
          title={`Next queue — ${nextTurnTotal ?? nextTurnMessages.length} ${
            (nextTurnTotal ?? nextTurnMessages.length) === 1 ? 'message' : 'messages'
          }`}
          size="lg"
        >
          {unloaded > 0 && (
            <p class="mb-2 text-xs text-fg-muted" data-testid="queued-modal-unloaded-note">
              Showing the first {nextTurnMessages.length} queued messages ({unloaded} more not
              loaded).
            </p>
          )}
          <QueuePreviewRow
            messages={pageMessages}
            testId="queued-modal-list"
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
