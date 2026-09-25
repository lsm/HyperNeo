import { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Portal } from './Portal.tsx';
import { cn } from '../../lib/utils.ts';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ComponentChildren;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showCloseButton?: boolean;
  footer?: ComponentChildren;
  'data-testid'?: string;
}

export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const modalStack: Array<() => void> = [];
let openModalCount = 0;

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

export function setupFocusTrap(container: HTMLElement): () => void {
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
  footer,
  'data-testid': testId,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const close = () => onClose();
    modalStack.push(close);
    openModalCount += 1;
    document.body.style.overflow = 'hidden';

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === close) {
        close();
      }
    };
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
      const idx = modalStack.indexOf(close);
      if (idx !== -1) modalStack.splice(idx, 1);
      openModalCount -= 1;
      if (openModalCount <= 0) {
        openModalCount = 0;
        document.body.style.overflow = '';
      }
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
      <div class="absolute inset-0 bg-scrim backdrop-blur-sm cursor-pointer" onClick={onClose} />

      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        data-testid={testId}
        class={cn(
          'relative w-full bg-surface-overlay rounded-lg shadow-xl border border-line-strong animate-scaleIn flex flex-col max-h-[90vh]',
          sizes[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || showCloseButton) && (
          <div class="flex items-center justify-between px-4 py-3 border-b border-line flex-shrink-0">
            {title && <h2 class="text-sm font-semibold text-fg">{title}</h2>}
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                class="ml-auto text-fg-muted hover:text-fg transition-colors p-1 rounded hover:bg-fill-strong"
                aria-label="Close modal"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

        <div class="p-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div class="px-4 py-3 border-t border-line flex-shrink-0">{footer}</div>}
      </div>
    </div>
  );

  return <Portal into="body">{modalContent}</Portal>;
}
