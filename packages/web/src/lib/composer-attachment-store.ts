import { signal } from '@preact/signals';
import type { AttachmentWithMetadata } from '../hooks/useFileAttachments.ts';

export const composerAttachmentsSignal = signal<Record<string, AttachmentWithMetadata[]>>({});

export const EMPTY_ATTACHMENTS: AttachmentWithMetadata[] = [];

export function readPendingComposerAttachments(sessionId: string): AttachmentWithMetadata[] {
  return composerAttachmentsSignal.value[sessionId] ?? EMPTY_ATTACHMENTS;
}

export function writePendingComposerAttachments(
  sessionId: string,
  next: AttachmentWithMetadata[]
): void {
  const prev = composerAttachmentsSignal.peek();
  if (next.length === 0) {
    if (!(sessionId in prev)) return;
    const rest = { ...prev };
    delete rest[sessionId];
    composerAttachmentsSignal.value = rest;
    return;
  }
  if (prev[sessionId] === next) return;
  composerAttachmentsSignal.value = { ...prev, [sessionId]: next };
}
