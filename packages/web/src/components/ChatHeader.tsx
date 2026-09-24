import type { ChatMessage, Session, SessionFeatures } from '@hyperneo/shared';
import { DEFAULT_WORKER_FEATURES } from '@hyperneo/shared';
import { rightPanelTargetSignal } from '../lib/signals.ts';
import { cn } from '../lib/utils.ts';
import { MobileMenuButton } from './ui/MobileMenuButton';
import { SessionInfoPanelButton } from './SessionInfoPanel.tsx';

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
  messages?: ChatMessage[];
  backgroundTaskMessages?: ChatMessage[];
  toolInputsMap?: Map<string, unknown>;
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
  messages = [],
  backgroundTaskMessages = [],
  toolInputsMap = new Map(),
  titleOverride,
  onBack,
  onReturnToParent,
}: ChatHeaderProps) {
  const returnedAt = session?.metadata.clone?.returnedAt;
  const isClone = !!session?.parentSessionId;
  const rightPanelOpen = rightPanelTargetSignal.value !== null;
  const rightPanelAvailable = !!session?.id && Boolean(session.workspacePath || session.worktree);

  return (
    <div
      data-tauri-drag-region
      class={cn(
        'relative z-30 flex h-[52px] flex-shrink-0 items-center bg-app-content px-4',
        rightPanelAvailable && !rightPanelOpen && 'pr-14'
      )}
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
          <h2
            data-testid="chat-header-title"
            class="min-w-0 truncate text-sm font-semibold text-fg"
            data-tauri-drag-region
          >
            {titleOverride || session?.title || 'New Session'}
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
            class="flex-shrink-0 rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-strong hover:text-fg focus:outline-none focus:ring-1 focus:ring-gray-600"
            data-testid="chat-header-return-to-parent"
          >
            Return to parent
          </button>
        )}

        <SessionInfoPanelButton
          session={session}
          features={features}
          onToolsClick={onToolsClick}
          onExportClick={onExportClick}
          onResetClick={onResetClick}
          onArchiveClick={onArchiveClick}
          onDeleteClick={onDeleteClick}
          archiving={archiving}
          resettingAgent={resettingAgent}
          readonly={readonly}
          messages={messages}
          backgroundTaskMessages={backgroundTaskMessages}
          toolInputsMap={toolInputsMap}
        />
      </div>
    </div>
  );
}
