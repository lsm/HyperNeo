/**
 * InputActionsMenu Component
 *
 * Plus button with dropdown menu for message input actions.
 * Includes auto-scroll toggle, tools, and file attachment.
 * Extracted from MessageInput.tsx for better separation of concerns.
 */

import type { RefObject } from 'preact';
import { useRef } from 'preact/hooks';
import type { ModelInfo } from '@neokai/shared';
import { cn } from '../lib/utils';
import { borderColors } from '../lib/design-tokens';
import { useClickOutside } from '../hooks/useClickOutside';

export interface InputActionsMenuProps {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Toggle menu open/close */
  onToggle: () => void;
  /** Close the menu */
  onClose: () => void;
  /** Model switcher state (unused but kept for future model switching in menu) */
  currentModel?: string;
  currentModelInfo?: ModelInfo | null;
  availableModels?: ModelInfo[];
  modelSwitching?: boolean;
  modelLoading?: boolean;
  onModelSwitch?: (model: ModelInfo) => void;
  /** Auto-scroll state */
  autoScroll: boolean;
  onAutoScrollChange: (enabled: boolean) => void;
  /** Open tools modal */
  onOpenTools: () => void;
  /** Trigger file input */
  onAttachFile: () => void;
  /** Whether actions are disabled */
  disabled?: boolean;
  /** Ref to the plus button for click-outside detection */
  buttonRef?: RefObject<HTMLButtonElement>;
}

export function InputActionsMenu({
  isOpen,
  onToggle,
  onClose,
  currentModel: _currentModel,
  currentModelInfo: _currentModelInfo,
  availableModels: _availableModels,
  modelSwitching: _modelSwitching,
  modelLoading: _modelLoading,
  onModelSwitch: _onModelSwitch,
  autoScroll,
  onAutoScrollChange,
  onOpenTools,
  onAttachFile,
  disabled = false,
  buttonRef: externalButtonRef,
}: InputActionsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const internalButtonRef = useRef<HTMLButtonElement>(null);
  const buttonRef = externalButtonRef || internalButtonRef;

  // Handle click outside
  useClickOutside(menuRef, onClose, isOpen, [buttonRef]);

  const handleAutoScrollToggle = () => {
    onAutoScrollChange(!autoScroll);
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
      {/* Plus Button */}
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
          `bg-dark-700/80 border ${borderColors.ui.secondary}`,
          disabled
            ? 'opacity-50 cursor-not-allowed text-gray-500'
            : 'text-gray-300 hover:bg-dark-600 hover:text-white active:scale-95'
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

      {/* Menu Popover */}
      {isOpen && (
        <div
          ref={menuRef}
          class={`absolute bottom-full left-0 mb-2 bg-dark-800 border ${borderColors.ui.secondary} rounded-xl shadow-2xl overflow-hidden animate-slideIn min-w-[220px] z-50`}
        >
          {/* Auto-scroll Toggle */}
          <button
            type="button"
            onClick={handleAutoScrollToggle}
            class="w-full px-4 py-3 text-left flex items-center justify-between transition-colors text-gray-200 hover:bg-dark-700/50"
          >
            <span class="flex items-center gap-3">
              <svg
                class={cn('w-5 h-5', autoScroll ? 'text-blue-400' : 'text-gray-400')}
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
                class="w-4 h-4 text-blue-400"
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

          {/* Tools */}
          <button
            type="button"
            onClick={handleToolsClick}
            class="w-full px-4 py-3 text-left flex items-center gap-3 transition-colors text-gray-200 hover:bg-dark-700/50"
          >
            <svg
              class="w-5 h-5 text-orange-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
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

          <div class="h-px bg-dark-600" />

          {/* Attach File */}
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={disabled}
            class={cn(
              'w-full px-4 py-3 text-left flex items-center gap-3 transition-colors text-gray-200 hover:bg-dark-700/50',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            <svg
              class="w-5 h-5 text-gray-400"
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
