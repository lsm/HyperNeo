import type { MessageImage } from '@hyperneo/shared/types';
import { formatFileSize } from '../lib/file-utils.ts';

interface AttachmentPreviewProps {
  attachments: Array<MessageImage & { name: string; size: number }>;
  onRemove: (index: number) => void;
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div class="flex flex-wrap gap-2 p-2 bg-surface-raised/50 rounded-lg border border-line">
      {attachments.map((attachment, index) => (
        <div
          key={index}
          class="relative group w-20 h-20 rounded overflow-hidden border border-line-strong hover:border-fg-faint transition-colors"
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
            onClick={() => onRemove(index)}
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
    </div>
  );
}
