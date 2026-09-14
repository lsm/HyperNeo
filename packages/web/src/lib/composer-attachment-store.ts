import { signal } from '@preact/signals';
import type { MessageImage } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';
import { connectionState } from './state';
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
  ensureDeletionPurge();
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

export function dropPendingComposerAttachments(sessionId: string): void {
  writePendingComposerAttachments(sessionId, []);
}

export function removeDeliveredComposerAttachments(
  sessionId: string,
  delivered: Array<Pick<MessageImage, 'data'>>
): void {
  const prev = composerAttachmentsSignal.peek()[sessionId];
  if (!prev || prev.length === 0) return;
  const deliveredData = new Set(delivered.map((image) => image.data));
  const next = prev.filter((attachment) => !deliveredData.has(attachment.data));
  if (next.length === prev.length) return;
  writePendingComposerAttachments(sessionId, next);
}

let stopDeletionWatch: (() => void) | null = null;

function ensureDeletionPurge(): void {
  if (stopDeletionWatch) return;
  let unsubEvent: (() => void) | null = null;
  const register = (): void => {
    if (unsubEvent) return;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    unsubEvent = hub.onEvent<{ sessionId?: string }>('session.deleted', (event) => {
      if (event?.sessionId) dropPendingComposerAttachments(event.sessionId);
    });
  };
  register();
  const unsubscribeConnection = connectionState.subscribe(() => {
    if (unsubEvent) {
      unsubEvent();
      unsubEvent = null;
    }
    register();
  });
  stopDeletionWatch = () => {
    unsubscribeConnection();
    unsubEvent?.();
    unsubEvent = null;
  };
}
