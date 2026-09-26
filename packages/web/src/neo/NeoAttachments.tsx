import type { NeoAttachment } from './neo-attachments.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { formatFileSize } from '../lib/file-utils.ts';

export function NeoAttachments({
  files,
  onRemove,
}: {
  files: NeoAttachment[];
  onRemove: (ids: string[]) => void;
}) {
  return (
    <ul aria-label="Attachments" class="mb-3 flex max-h-32 flex-wrap gap-2 overflow-y-auto">
      {files.map((file) => (
        <li
          key={file.id}
          class="flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-2 py-2"
        >
          {file.kind === 'image' ? (
            <img
              src={`data:${file.image.media_type};base64,${file.image.data}`}
              alt={file.name}
              class="h-10 w-10 rounded-lg object-cover"
            />
          ) : (
            <NeoIcon name="file" class="text-accent" />
          )}
          <span class="min-w-0">
            <span class="block max-w-36 truncate text-xs" title={file.name}>
              {file.name}
            </span>
            <span class="text-[10px] text-fg-faint">{formatFileSize(file.size)}</span>
          </span>
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove([file.id])}
            class="rounded-lg p-2 text-fg-muted hover:bg-fill-soft"
          >
            <NeoIcon name="close" class="!h-3.5 !w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
