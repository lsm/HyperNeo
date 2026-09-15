import { signal } from '@preact/signals';
import type { MessageImage } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';
import { classifySessionLoadError } from './session-load-error';
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

function reconcileDeletedSessions(
  hub: NonNullable<ReturnType<typeof connectionManager.getHubIfConnected>>
): void {
  for (const sessionId of Object.keys(composerAttachmentsSignal.peek())) {
    if (sessionId.startsWith('pending:')) continue;
    hub
      .request<{ session?: unknown }>('session.get', { sessionId })
      .then((response) => {
        if (!response?.session) dropPendingComposerAttachments(sessionId);
      })
      .catch((err: unknown) => {
        const { kind } = classifySessionLoadError(err, connectionState.value);
        if (kind === 'not-found' || kind === 'unauthorized') {
          dropPendingComposerAttachments(sessionId);
        }
      });
  }
}

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
  const reconcileIfConnected = (): void => {
    const hub = connectionManager.getHubIfConnected();
    if (hub) reconcileDeletedSessions(hub);
  };
  register();
  reconcileIfConnected();
  const unsubscribeConnection = connectionState.subscribe((state) => {
    if (unsubEvent) {
      unsubEvent();
      unsubEvent = null;
    }
    register();
    if (state === 'connected') reconcileIfConnected();
  });
  stopDeletionWatch = () => {
    unsubscribeConnection();
    unsubEvent?.();
    unsubEvent = null;
  };
}
