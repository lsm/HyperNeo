import { isOxapHarness } from '@hyperneo/shared/types/oxap-harnesses';
import { ChevronLeftGlyph } from './icons/common-glyphs.tsx';
import type { ChatDisplayMode, Session, SessionFeatures } from '@hyperneo/shared';
import { DEFAULT_WORKER_FEATURES } from '@hyperneo/shared';
import { sessionStore } from '../lib/session-store.ts';
import { conversationTitle } from '../lib/session-sidebar-status.ts';
import { rightPanelTargetSignal } from '../lib/signals.ts';
import { shellExtensions } from '../lib/web-extensions.ts';
import { useSessionRename } from '../hooks/useSessionRename.ts';
import { MobileMenuButton } from './ui/MobileMenuButton';
import { ChatHeaderMenu, type ChatHeaderCopyItem } from './ChatHeaderMenu.tsx';
import { CloneIcon } from './icons/CloneIcon.tsx';
import { MoveSessionDialog, movableSession, moveSession } from './MoveSessionDialog.tsx';
import { sessions } from '../lib/state.ts';
import { useState } from 'preact/hooks';

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
  displayMode?: ChatDisplayMode;
  onDisplayModeChange?: (mode: ChatDisplayMode) => void;
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
  displayMode,
  onDisplayModeChange,
}: ChatHeaderProps) {
  const folder = session?.worktree?.worktreePath ?? session?.workspacePath;
  const returnedAt = session?.metadata.clone?.returnedAt;
  const isChild = !!session?.parentSessionId && !session.id.startsWith('neo:');
  const isClone = isChild && !session?.metadata.movedUnderParent;
  const [moving, setMoving] = useState(false);
  const movable = !!session && !readonly && movableSession(session);
  const hasChildren =
    !!session && sessions.value.some((item) => item.parentSessionId === session.id);
  const { isEditing, startEditing, inputProps } = useSessionRename(
    session?.id ?? '',
    session?.title ?? ''
  );
  const agentOwned =
    !!session &&
    shellExtensions().flatMap((extension) => extension.sessionAgent(session.id) ?? []).length > 0;
  const renamable = !!session && !readonly && !agentOwned;
  const target = rightPanelTargetSignal.value;
  const schedulesAvailable = !!session && sessionStore.activeSessionId.value === session.id;
  const schedulesOpen = target?.type === 'schedules' && target.sessionId === session?.id;
  const toggleSchedules = () => {
    if (!session) return;
    rightPanelTargetSignal.value = schedulesOpen
      ? null
      : { type: 'schedules', sessionId: session.id };
  };
  const branch = session?.worktree?.branch ?? session?.gitBranch;
  const copyItems: ChatHeaderCopyItem[] = session
    ? [
        { label: 'Session ID', value: session.id },
        ...(folder ? [{ label: 'Workspace path', value: folder }] : []),
        ...(branch ? [{ label: 'Branch', value: branch }] : []),
      ]
    : [];

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
            <ChevronLeftGlyph
              class="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width={2}
              pathProps={{ 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }}
            />
          </button>
        ) : (
          <MobileMenuButton />
        )}

        <div class="flex flex-1 min-w-0 items-center gap-1.5" data-tauri-drag-region>
          {isClone && (
            <span
              role="img"
              class="flex-shrink-0 text-fg-muted"
              title="Clone conversation"
              aria-label="Clone conversation"
            >
              <CloneIcon className="h-4 w-4" />
            </span>
          )}
          {isEditing ? (
            <input
              {...inputProps}
              data-testid="chat-header-rename-input"
              placeholder="Conversation title"
              class="min-w-0 flex-1 rounded-md border border-line-strong bg-surface/80 px-2 py-1 text-sm font-semibold text-fg outline-none focus:border-fg-faint"
            />
          ) : (
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
          )}
          {folder && (
            <span
              data-testid="chat-header-folder"
              title={folder}
              class="max-w-[45%] truncate text-xs text-fg-muted"
            >
              {folder}
            </span>
          )}
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
          showTools={!isOxapHarness(session?.config?.harness)}
          archived={session?.status === 'archived'}
          archiving={archiving}
          resettingAgent={resettingAgent}
          onToolsClick={onToolsClick}
          onExportClick={onExportClick}
          onResetClick={onResetClick}
          onArchiveClick={onArchiveClick}
          onDeleteClick={onDeleteClick}
          onMoveUnderClick={movable && !isChild && !hasChildren ? () => setMoving(true) : undefined}
          onMoveToTopClick={
            movable && isChild ? () => void moveSession(session!.id, null) : undefined
          }
          onRenameClick={renamable ? startEditing : undefined}
          onSchedulesClick={schedulesAvailable ? toggleSchedules : undefined}
          schedulesOpen={schedulesOpen}
          copyItems={copyItems}
          displayMode={displayMode}
          onDisplayModeChange={onDisplayModeChange}
        />
        {session && moving && (
          <MoveSessionDialog session={session} isOpen onClose={() => setMoving(false)} />
        )}
      </div>
    </div>
  );
}
