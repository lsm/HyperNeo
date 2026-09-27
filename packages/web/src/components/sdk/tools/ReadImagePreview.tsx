import { useEffect, useRef, useState } from 'preact/hooks';
import { Portal } from '../../ui/Portal.tsx';

interface ReadImagePreviewProps {
  src: string;
  filePath?: string;
}

export function ReadImagePreview({ src, filePath }: ReadImagePreviewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasOpenedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const label = filePath ? `Image read from ${filePath}` : 'Image read by agent';

  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setIsOpen(false);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        dialogRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      hasOpenedRef.current = true;
    } else if (hasOpenedRef.current) {
      triggerRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        class="block max-w-full cursor-zoom-in rounded border border-line overflow-hidden"
        aria-label={`Open ${label} full size`}
        title="Open full size"
        onClick={() => setIsOpen(true)}
      >
        <img src={src} alt={label} class="max-h-64 max-w-full object-contain" />
      </button>
      {isOpen && (
        <Portal into="body">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabindex={-1}
            class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-scrim backdrop-blur-sm outline-none"
            onClick={() => setIsOpen(false)}
          >
            <button
              type="button"
              class="absolute right-4 top-4 rounded p-2 text-accent-fg hover:bg-surface-raised/20"
              aria-label="Close image"
              onClick={() => setIsOpen(false)}
            >
              ✕
            </button>
            <img
              src={src}
              alt={label}
              class="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        </Portal>
      )}
    </>
  );
}
