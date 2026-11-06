import type { MessageImage } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { Modal } from '../components/ui/Modal.tsx';
import { t } from '../lib/i18n/index.ts';
import type { NeoAttachment, NeoSentFile } from './neo-attachments.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { formatFileSize } from '../lib/file-utils.ts';

export function NeoFileChip({
  name,
  size,
  image,
}: {
  name: string;
  size: number;
  image?: MessageImage;
}) {
  return (
    <>
      {image ? (
        <img
          src={`data:${image.media_type};base64,${image.data}`}
          alt={name}
          class="h-10 w-10 rounded-lg object-cover"
        />
      ) : (
        <NeoIcon name="file" class="text-accent" />
      )}
      <span class="min-w-0">
        <span class="block max-w-36 truncate text-xs" title={name}>
          {name}
        </span>
        <span class="text-[10px] text-fg-faint">{formatFileSize(size)}</span>
      </span>
    </>
  );
}

export function NeoSentFiles({ files }: { files: NeoSentFile[] }) {
  const [opened, setOpened] = useState<NeoSentFile | null>(null);
  return (
    <>
      {files.map((file, index) => (
        <button
          key={index}
          type="button"
          aria-label={t('chat.openFile', { name: file.name })}
          onClick={() => setOpened(file)}
          class="flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-2 py-2 text-left hover:bg-fill-soft"
        >
          <NeoFileChip name={file.name} size={new TextEncoder().encode(file.text).length} />
        </button>
      ))}
      {opened && (
        <Modal isOpen title={opened.name} onClose={() => setOpened(null)}>
          <pre class="select-text whitespace-pre-wrap break-words text-sm">{opened.text}</pre>
        </Modal>
      )}
    </>
  );
}

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
          <NeoFileChip
            name={file.name}
            size={file.size}
            image={file.kind === 'image' ? file.image : undefined}
          />
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
