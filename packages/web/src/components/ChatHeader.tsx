import type { Session, SessionFeatures } from '@hyperneo/shared';
import { DEFAULT_WORKER_FEATURES } from '@hyperneo/shared';
import { sessionStore } from '../lib/session-store.ts';
import { conversationTitle } from '../lib/session-sidebar-status.ts';
import { rightPanelTargetSignal } from '../lib/signals.ts';
import { cn } from '../lib/utils.ts';
import { MobileMenuButton } from './ui/MobileMenuButton';
import { ChatHeaderMenu } from './ChatHeaderMenu.tsx';
import { IconButton } from './ui/IconButton.tsx';
import { CloneIcon } from './icons/CloneIcon.tsx';

export interface ChatHeaderProps {
  session: Session | null;
  features?: SessionFeatures;
  onToolsClick: () => void;
  onExportClick: () => void;
  onResetClick: () => void;
  onArchiveClick: () => void;
  onDeleteClick: () => void;
  archiving?: boolean;
  resettingAgent?: boolean;
  readonly?: boolean;
  titleOverride?: string;
  onBack?: () => void;
  onReturnToParent?: () => void;
}

export function ChatHeader({
  session,
  features = DEFAULT_WORKER_FEATURES,
  onToolsClick,
  onExportClick,
  onResetClick,
  onArchiveClick,
  onDeleteClick,
  archiving = false,
  resettingAgent = false,
  readonly = false,
  titleOverride,
  onBack,
  onReturnToParent,
}: ChatHeaderProps) {
  const returnedAt = session?.metadata.clone?.returnedAt;
  const isClone = !!session?.parentSessionId;
  const target = rightPanelTargetSignal.value;
  const inspectorAvailable = !!session && sessionStore.activeSessionId.value === session.id;
  const inspectorOpen = target?.type === 'inspector' && target.sessionId === session?.id;
  const toggleInspector = () => {
    if (!session) return;
    rightPanelTargetSignal.value = inspectorOpen
      ? null
      : { type: 'inspector', sessionId: session.id };
  };

  return (
    <div
      data-tauri-drag-region
      class="relative z-30 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4"
    >
      <div class="flex-1 min-w-0 flex items-center gap-3" data-tauri-drag-region>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            class="flex-shrink-0 p-1.5 rounded text-fg-muted hover:text-fg hover:bg-fill-strong transition-colors focus:outline-none focus:ring-1 focus:ring-gray-600"
            aria-label="Back"
            data-testid="chat-header-back"
          >
            <svg
              class="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width={2}
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        ) : (
          <MobileMenuButton />
        )}

        <div class="flex flex-1 min-w-0 items-center gap-1.5" data-tauri-drag-region>
          {isClone && (
            <span
              class="flex-shrink-0 text-fg-muted"
              title="Clone conversation"
              aria-label="Clone conversation"
            >
              <CloneIcon className="h-4 w-4" />
            </span>
          )}
          <h2
            data-testid="chat-header-title"
            title={conversationTitle(
              titleOverride || session?.title || 'New conversation',
              isClone
            )}
            class="min-w-0 truncate text-sm font-semibold text-fg"
            data-tauri-drag-region
          >
            {conversationTitle(titleOverride || session?.title || 'New conversation', isClone)}
          </h2>
          {isClone && returnedAt && (
            <span
              class="flex-shrink-0 text-[11px] text-fg-faint"
              data-testid="chat-header-returned"
              title={`Returned ${returnedAt}`}
            >
              ✓ returned
            </span>
          )}
        </div>

        {isClone && onReturnToParent && !readonly && session?.status === 'active' && (
          <button
            type="button"
            onClick={onReturnToParent}
            aria-label="Return to parent"
            title="Return to parent"
            class="inline-flex min-h-8 min-w-8 flex-shrink-0 items-center justify-center rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            data-testid="chat-header-return-to-parent"
          >
            <svg
              class="h-4 w-4 sm:hidden"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 6 6v3"
                stroke-width={1.75}
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="hidden sm:inline">Return to parent</span>
          </button>
        )}

        <ChatHeaderMenu
          features={features}
          readonly={readonly}
          archived={session?.status === 'archived'}
          archiving={archiving}
          resettingAgent={resettingAgent}
          onToolsClick={onToolsClick}
          onExportClick={onExportClick}
          onResetClick={onResetClick}
          onArchiveClick={onArchiveClick}
          onDeleteClick={onDeleteClick}
        />
        {inspectorAvailable && (
          <IconButton
            title="Conversation info"
            data-testid="session-info-btn"
            onClick={toggleInspector}
            class={cn('flex-shrink-0 text-fg-muted', inspectorOpen && 'bg-fill text-fg')}
          >
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={1.9}
                d="M12 11.5v5M12 7.25h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
              />
            </svg>
          </IconButton>
        )}
      </div>
    </div>
  );
}
