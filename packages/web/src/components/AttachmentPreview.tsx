import type { MessageImage } from '@hyperneo/shared/types';
import { useEffect, useState } from 'preact/hooks';
import { formatFileSize } from '../lib/file-utils.ts';
import { Portal } from './ui/Portal.tsx';

interface AttachmentPreviewProps {
  attachments: Array<MessageImage & { name: string; size: number }>;
  onRemove: (index: number) => void;
}

export const ATTACHMENT_LIGHTBOX_TEST_ID = 'attachment-lightbox';

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  const [enlargedIndex, setEnlargedIndex] = useState<number | null>(null);
  const enlarged =
    enlargedIndex !== null && enlargedIndex < attachments.length
      ? attachments[enlargedIndex]
      : undefined;

  useEffect(() => {
    if (enlargedIndex === null) return;
    if (enlargedIndex >= attachments.length) {
      setEnlargedIndex(null);
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEnlargedIndex(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enlargedIndex, attachments.length]);

  if (attachments.length === 0) return null;

  return (
    <div class="flex flex-wrap gap-2 p-2 bg-surface-raised/50 rounded-lg border border-line">
      {attachments.map((attachment, index) => (
        <div
          key={index}
          class="relative group w-20 h-20 rounded overflow-hidden border border-line-strong hover:border-fg-faint transition-colors cursor-zoom-in"
          title="Open full size"
          onClick={() => setEnlargedIndex(index)}
        >
          <img
            src={`data:${attachment.media_type};base64,${attachment.data}`}
            alt={attachment.name}
            class="w-full h-full object-cover"
          />

          <div class="absolute inset-0 bg-scrim-strong opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center p-1">
            <div class="text-xs text-accent-fg text-center truncate w-full px-1">
              {attachment.name}
            </div>
            <div class="text-xs text-accent-fg opacity-80">{formatFileSize(attachment.size)}</div>
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(index);
            }}
            class="absolute top-1 right-1 w-5 h-5 rounded-full bg-danger hover:bg-danger text-on-danger flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
            aria-label="Remove attachment"
            title="Remove attachment"
          >
            <svg
              class="w-3 h-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}

      {enlarged && (
        <Portal into="body">
          <div
            data-testid={ATTACHMENT_LIGHTBOX_TEST_ID}
            role="dialog"
            aria-modal="true"
            aria-label={enlarged.name}
            class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-scrim backdrop-blur-sm cursor-zoom-out animate-fadeIn"
            onClick={() => setEnlargedIndex(null)}
          >
            <img
              src={`data:${enlarged.media_type};base64,${enlarged.data}`}
              alt={enlarged.name}
              class="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            />
          </div>
        </Portal>
      )}
    </div>
  );
}
