import { t } from '../lib/i18n/index.ts';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Portal } from './ui/Portal.tsx';

export const ATTACHMENT_LIGHTBOX_TEST_ID = 'attachment-lightbox';

export function PhotoLightbox({
  src,
  label,
  onClose,
}: {
  src: string;
  label: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        dialog.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, []);
  return (
    <Portal into="body">
      <div
        ref={dialog}
        data-testid={ATTACHMENT_LIGHTBOX_TEST_ID}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabindex={-1}
        class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-scrim backdrop-blur-sm cursor-zoom-out animate-fadeIn outline-none"
        onClick={onClose}
      >
        <img
          src={src}
          alt={label}
          class="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
        />
      </div>
    </Portal>
  );
}

export function PhotoThumbnail({
  src,
  fullSrc,
  label,
  style,
  initiallyOpen = false,
}: {
  src: string;
  fullSrc?: string;
  label: string;
  style?: JSX.CSSProperties;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        aria-label={t('chat.openNamed', { name: label.toLowerCase() })}
        class="block max-w-full cursor-zoom-in rounded-xl"
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={label}
          style={style}
          class="max-h-64 max-w-full rounded-xl object-contain"
        />
      </button>
      {open && (
        <PhotoLightbox
          src={fullSrc ?? src}
          label={label}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
