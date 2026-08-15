import { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Portal } from './Portal.tsx';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ComponentChildren;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showCloseButton?: boolean;
}

/** Focusable element selector */
export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Creates a focus trap handler for modal dialogs.
 * Exported for testing purposes.
 */
export function createFocusTrapHandler(
  firstElement: HTMLElement | null,
  lastElement: HTMLElement | null
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    }
  };
}

/**
 * Sets up focus trap on a container element.
 * Exported for testing purposes.
 * @returns cleanup function to remove the event listener
 */
export function setupFocusTrap(container: HTMLElement): () => void {
  // Query the focusable list AT EVENT TIME rather than snapshotting it at
  // setup: conditionally-rendered controls (e.g. the global recording chip
  // inside the agent overlay panel) can appear after the trap was set up,
  // and a snapshotted first/last pair would keep wrapping Tab past them.
  const handleTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusableElements = container.querySelectorAll(FOCUSABLE_SELECTOR);
    if (focusableElements.length === 0) return;
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;
    const wrap = createFocusTrapHandler(firstElement, lastElement);
    wrap(e);
  };

  container.addEventListener('keydown', handleTab as EventListener);
  container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();

  return () => {
    container.removeEventListener('keydown', handleTab as EventListener);
  };
}

export function Modal({
  isOpen,
  onClose,
  children,
  title,
  size = 'md',
  showCloseButton = true,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && modalRef.current) {
      return setupFocusTrap(modalRef.current);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  const modalContent = (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fadeIn">
      {/* Backdrop */}
      <div class="absolute inset-0 bg-black/70 backdrop-blur-sm cursor-pointer" onClick={onClose} />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        class={cn(
          `relative w-full bg-dark-900 rounded-xl shadow-2xl border ${borderColors.ui.default} animate-scaleIn flex flex-col max-h-[90vh]`,
          sizes[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {(title || showCloseButton) && (
          <div
            class={`flex items-center justify-between px-6 py-4 border-b ${borderColors.ui.default} flex-shrink-0`}
          >
            {title && <h2 class="text-lg font-semibold text-gray-100">{title}</h2>}
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                class="ml-auto text-gray-400 hover:text-gray-100 transition-colors p-1 rounded-lg hover:bg-dark-800"
                aria-label="Close modal"
              >
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div class="px-6 py-4 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );

  // Render in portal to avoid z-index issues
  return <Portal into="body">{modalContent}</Portal>;
}
