import type { RefObject } from 'preact';
import { useRef } from 'preact/hooks';
import type { ModelInfo, SessionFeatures } from '@hyperneo/shared';
import { DEFAULT_WORKER_FEATURES } from '@hyperneo/shared';
import { cn } from '../lib/utils';
import { useClickOutside } from '../hooks/useClickOutside';

export interface InputActionsMenuProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  currentModel?: string;
  currentModelInfo?: ModelInfo | null;
  availableModels?: ModelInfo[];
  modelSwitching?: boolean;
  modelLoading?: boolean;
  onModelSwitch?: (model: ModelInfo) => void;
  autoScroll: boolean;
  onAutoScrollChange: (enabled: boolean) => void;
  onOpenTools: () => void;
  onAttachFile: () => void;
  coordinatorMode?: boolean;
  coordinatorSwitching?: boolean;
  onCoordinatorModeChange?: (enabled: boolean) => void;
  sandboxEnabled?: boolean;
  sandboxSwitching?: boolean;
  onSandboxModeChange?: (enabled: boolean) => void;
  features?: SessionFeatures;
  disabled?: boolean;
  buttonRef?: RefObject<HTMLButtonElement>;
}

export function InputActionsMenu({
  isOpen,
  onToggle,
  onClose,
  currentModel: _currentModel,
  currentModelInfo: _currentModelInfo,
  availableModels: _availableModels,
  modelSwitching,
  modelLoading: _modelLoading,
  onModelSwitch: _onModelSwitch,
  autoScroll,
  onAutoScrollChange,
  onOpenTools,
  onAttachFile,
  coordinatorMode = false,
  coordinatorSwitching = false,
  onCoordinatorModeChange,
  sandboxEnabled = false,
  sandboxSwitching = false,
  onSandboxModeChange,
  features = DEFAULT_WORKER_FEATURES,
  disabled = false,
  buttonRef: externalButtonRef,
}: InputActionsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const internalButtonRef = useRef<HTMLButtonElement>(null);
  const buttonRef = externalButtonRef || internalButtonRef;

  useClickOutside(menuRef, onClose, isOpen, [buttonRef]);

  const handleAutoScrollToggle = () => {
    onAutoScrollChange(!autoScroll);
    onClose();
  };

  const handleCoordinatorToggle = () => {
    onCoordinatorModeChange?.(!coordinatorMode);
    onClose();
  };

  const handleSandboxToggle = () => {
    onSandboxModeChange?.(!sandboxEnabled);
    onClose();
  };

  const handleToolsClick = () => {
    onOpenTools();
    onClose();
  };

  const handleAttachClick = () => {
    if (!disabled) {
      onAttachFile();
      onClose();
    }
  };

  return (
    <div class="relative flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          onToggle();
        }}
        class={cn(
          'w-[46px] h-[46px] rounded-full flex items-center justify-center transition-all',
          `bg-fill-strong/80 border border-line-strong`,
          disabled
            ? 'opacity-50 cursor-not-allowed text-fg-faint'
            : 'text-fg-soft hover:bg-line-strong hover:text-fg active:scale-95'
        )}
        title={disabled ? 'Not connected' : 'More options'}
      >
        <svg
          class={cn('w-5 h-5 transition-transform duration-200', isOpen && 'rotate-45')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width={2}
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          class="absolute bottom-full left-0 mb-2 bg-surface-raised border border-line-strong rounded-xl shadow-2xl overflow-hidden animate-slideIn min-w-[220px] z-50"
        >
          <button
            type="button"
            onClick={handleAutoScrollToggle}
            class="w-full px-4 py-3 text-left flex items-center justify-between transition-colors text-fg-soft hover:bg-fill-strong/50"
          >
            <span class="flex items-center gap-3">
              <svg
                class={cn('w-5 h-5', autoScroll ? 'text-accent' : 'text-fg-muted')}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M19 14l-7 7m0 0l-7-7m7 7V3"
                />
              </svg>
              <span class="text-sm">Auto-scroll</span>
            </span>
            {autoScroll && (
              <svg
                class="w-4 h-4 text-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2.5}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </button>

          {features.coordinator && (
            <button
              type="button"
              onClick={handleCoordinatorToggle}
              disabled={coordinatorSwitching || modelSwitching}
              class="w-full px-4 py-3 text-left flex items-center justify-between transition-colors text-fg-soft hover:bg-fill-strong/50 disabled:opacity-50"
            >
              <span class="flex items-center gap-3">
                <svg
                  class={cn('w-5 h-5', coordinatorMode ? 'text-cat-purple' : 'text-fg-muted')}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
                <span class="text-sm">Coordinator Mode</span>
              </span>
              {coordinatorMode && (
                <svg
                  class="w-4 h-4 text-cat-purple"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2.5}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </button>
          )}

          {features.worktree && (
            <button
              type="button"
              onClick={handleSandboxToggle}
              disabled={sandboxSwitching || modelSwitching}
              class="w-full px-4 py-3 text-left flex items-center justify-between transition-colors text-fg-soft hover:bg-fill-strong/50 disabled:opacity-50"
            >
              <span class="flex items-center gap-3">
                <svg
                  class={cn('w-5 h-5', sandboxEnabled ? 'text-success' : 'text-fg-muted')}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                  />
                </svg>
                <span class="text-sm">Sandbox Mode</span>
              </span>
              {sandboxEnabled && (
                <svg
                  class="w-4 h-4 text-success"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2.5}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </button>
          )}

          <div class="h-px bg-line-strong" />

          <button
            type="button"
            onClick={handleToolsClick}
            class="w-full px-4 py-3 text-left flex items-center gap-3 transition-colors text-fg-soft hover:bg-fill-strong/50"
          >
            <svg class="w-5 h-5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span class="text-sm">Tools</span>
          </button>

          <div class="h-px bg-line-strong" />

          <button
            type="button"
            onClick={handleAttachClick}
            disabled={disabled}
            class={cn(
              'w-full px-4 py-3 text-left flex items-center gap-3 transition-colors text-fg-soft hover:bg-fill-strong/50',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <svg
              class="w-5 h-5 text-fg-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
              />
            </svg>
            <span class="text-sm">Attach image</span>
          </button>
        </div>
      )}
    </div>
  );
}
