import { signal } from '@preact/signals';
import type { MessageImage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { fileToBase64, validateImageFile } from '../lib/file-utils.ts';

export type NeoAttachment = { id: string; name: string; size: number } & (
  | { kind: 'image'; image: MessageImage }
  | { kind: 'text'; text: string }
);
const drafts = signal<Record<string, { files: NeoAttachment[]; reading: number }>>({});
export const NEO_FILE_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,text/*,.md,.txt,.csv,.json,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.html,.css,.xml,.log,.sh,.sql';

function admitFile(file: File): { value: File } | { reason: string } {
  if (file.type.startsWith('image/')) {
    const error = validateImageFile(file);
    return error ? { reason: error } : { value: file };
  }
  if (
    !file.type.startsWith('text/') &&
    !/\.(md|txt|csv|json|ya?ml|[cm]?[jt]sx?|py|html|css|xml|log|sh|sql)$/i.test(file.name)
  )
    return {
      reason:
        'Use a photo or a text file (Markdown, CSV, JSON or code). PDF, Office and other binary files are not supported yet.',
    };
  if (!file.size || file.size > 128 * 1024)
    return { reason: 'Text files must be non-empty and under 128 KB.' };
  return { value: file };
}

async function readFile(file: File): Promise<{ value: NeoAttachment }> {
  const base = { id: crypto.randomUUID(), name: file.name, size: file.size };
  if (file.type.startsWith('image/'))
    return {
      value: {
        ...base,
        kind: 'image',
        image: {
          data: await fileToBase64(file),
          media_type: file.type as MessageImage['media_type'],
        },
      },
    };
  const text = await file.text();
  if (text.includes('\0') || text.includes('\uFFFD'))
    throw new Error('This file is not readable UTF-8 text.');
  return { value: { ...base, kind: 'text', text } };
}

export const readNeoAttachment = (superpipe({})('neo-read-attachment') as PipelineAPI)
  .input(['file'])
  .pipe(admitFile, 'file', 'result:attachment')
  .pipe(readFile, 'attachment', 'result:attachment')
  .endAsync('attachment') as (file: File) => Promise<NeoAttachment | string>;

export function attachmentMessage(draft: string, files: NeoAttachment[]) {
  const documents = files.flatMap((file) => {
    if (file.kind !== 'text') return [];
    const fence = '`'.repeat(
      Math.max(3, ...(file.text.match(/`+/g) ?? []).map((run) => run.length + 1))
    );
    const name = file.name.replace(/[\r\n]/g, ' ').replace(/([\\`*_{}[\]<>])/g, '\\$1');
    return [`### Attached file: ${name}\n\n${fence}text\n${file.text}\n${fence}`];
  });
  return [draft.trim() || (files.length ? 'Attached files' : ''), ...documents].join('\n\n');
}

export function useNeoAttachments(sessionId: string | null) {
  const state = (sessionId && drafts.value[sessionId]) || { files: [], reading: 0 };
  function update(change: (current: typeof state) => typeof state) {
    if (!sessionId) return;
    drafts.value = {
      ...drafts.peek(),
      [sessionId]: change(drafts.peek()[sessionId] ?? { files: [], reading: 0 }),
    };
  }
  async function add(files: File[], onError: (message: string) => void) {
    if (!sessionId) return;
    update((current) => ({ ...current, reading: current.reading + 1 }));
    try {
      for (const file of files.slice(0, 6)) {
        if ((drafts.peek()[sessionId]?.files.length ?? 0) >= 6) {
          onError('Attach up to 6 files at a time.');
          break;
        }
        try {
          const result = await readNeoAttachment(file);
          if (typeof result === 'string') {
            onError(`${file.name}: ${result}`);
            continue;
          }
          const payloadSize = (drafts.peek()[sessionId]?.files ?? []).reduce(
            (size, item) => size + (item.kind === 'image' ? item.image.data.length : item.size),
            0
          );
          if (
            payloadSize + (result.kind === 'image' ? result.image.data.length : result.size) >
            8 * 1024 * 1024
          ) {
            onError('Attachments are too large together. Remove a file or use smaller photos.');
            continue;
          }
          update((current) => ({
            ...current,
            files: current.files.length < 6 ? [...current.files, result] : current.files,
          }));
        } catch (error) {
          onError(error instanceof Error ? error.message : `Could not read ${file.name}`);
        }
      }
      if (files.length > 6) onError('Attach up to 6 files at a time.');
    } finally {
      update((current) => ({ ...current, reading: current.reading - 1 }));
    }
  }
  function remove(ids: string[]) {
    update((current) => ({
      ...current,
      files: current.files.filter((file) => !ids.includes(file.id)),
    }));
  }
  return { ...state, add, remove };
}
