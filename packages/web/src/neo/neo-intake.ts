import type { MessageHub, MessageImage } from '@hyperneo/shared';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { readNeoPreviewReference } from './neo-preview-context.ts';
import type { NeoReplyTo } from '@hyperneo/shared/types/neo-ask';
import { neoReplyExcerpt } from '@hyperneo/shared/types/neo-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../lib/operations.ts';
import { neoIntakeSnapshots } from './neo-intake-snapshot.ts';
import { createNeoIntakeStorage } from './neo-intake-storage.ts';
export const NEO_SEND_TIMEOUT_MS = 90_000;

export type NeoQuote = {
  author: 'You' | 'Neo';
  text: string;
  anchor: string;
  replyTo?: NeoReplyTo;
};
export type NeoDraft = {
  sessionId: string;
  text: string;
  images?: readonly MessageImage[];
  quote?: NeoQuote;
  previewContext?: NeoPreviewReference;
};
type Submission = NeoDraft & { requestId: string };
type PendingSubmission = { submission: Submission; flight?: Promise<IntakeReceipt> };
type IntakeReceipt =
  | {
      ok: true;
      requestId: string;
      messageId: string;
      created: boolean;
      previewContext?: NeoPreviewReference;
    }
  | { ok: false; reason: string };
type Rejection = Extract<IntakeReceipt, { ok: false }>;

export function admitNeoDraft<T extends NeoDraft>(
  submission: T
): { value: T } | { reason: Rejection } {
  if (!submission.sessionId || (!submission.text.trim() && !submission.images?.length))
    return { reason: { ok: false, reason: 'Add a message or attachment before sending.' } };
  if (
    submission.previewContext !== undefined &&
    !readNeoPreviewReference(submission.previewContext)
  )
    return { reason: { ok: false, reason: 'This Preview reference is invalid.' } };
  return { value: submission };
}

function captureNeoDraft<T extends NeoDraft>(draft: T): T {
  return {
    ...draft,
    images: draft.images?.map((image) => ({ ...image })),
    ...(draft.quote
      ? {
          quote: {
            ...draft.quote,
            ...(draft.quote.replyTo ? { replyTo: { ...draft.quote.replyTo } } : {}),
          },
        }
      : {}),
    ...(draft.previewContext ? { previewContext: { ...draft.previewContext } } : {}),
  };
}

const intakeSubmissions = new WeakSet<Submission>();
function captureNeoSubmission(submission: Submission): Submission {
  return intakeSubmissions.has(submission) ? submission : captureNeoDraft(submission);
}

type NeoThumbnail = {
  index: number;
  mediaType: 'image/jpeg';
  data: string;
  width?: number;
  height?: number;
};
const THUMBNAIL_EDGE = 256;
const THUMBNAIL_SIZE_LIMIT = 100_000;
const THUMBNAIL_LIMIT = 32 * 1024;
const THUMBNAIL_QUALITIES = [0.7, 0.5, 0.3];

function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function thumbnailSurface(width: number, height: number) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    return {
      context: canvas.getContext('2d'),
      encode: async (quality: number) => {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        return blob.type === 'image/jpeg'
          ? bytesBase64(new Uint8Array(await blob.arrayBuffer()))
          : null;
      },
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    context: canvas.getContext('2d'),
    encode: async (quality: number) => {
      const url = canvas.toDataURL('image/jpeg', quality);
      const prefix = 'data:image/jpeg;base64,';
      return url.startsWith(prefix) ? url.slice(prefix.length) : null;
    },
  };
}

async function neoPhotoThumbnail(image: MessageImage): Promise<Omit<NeoThumbnail, 'index'> | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))], {
      type: image.media_type,
    })
  );
  try {
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const surface = thumbnailSurface(width, height);
    if (!surface.context) return null;
    surface.context.fillStyle = 'white';
    surface.context.fillRect(0, 0, width, height);
    surface.context.drawImage(bitmap, 0, 0, width, height);
    for (const quality of THUMBNAIL_QUALITIES) {
      const data = await surface.encode(quality);
      if (data && data.length <= THUMBNAIL_LIMIT)
        return {
          mediaType: 'image/jpeg',
          data,
          ...(Math.max(bitmap.width, bitmap.height) <= THUMBNAIL_SIZE_LIMIT
            ? { width: bitmap.width, height: bitmap.height }
            : {}),
        };
    }
    return null;
  } finally {
    bitmap.close();
  }
}

const thumbnailsMade = new WeakMap<Submission, Promise<NeoThumbnail[]>>();

export function neoDraftThumbnails(submission: Submission): Promise<NeoThumbnail[]> {
  const made = thumbnailsMade.get(submission);
  if (made) return made;
  const offset = submission.text.trim() || (submission.quote && !submission.quote.replyTo) ? 1 : 0;
  const making = Promise.all(
    (submission.images ?? []).map((image, index) =>
      neoPhotoThumbnail(image).then(
        (thumbnail): NeoThumbnail[] => (thumbnail ? [{ index: offset + index, ...thumbnail }] : []),
        (): NeoThumbnail[] => []
      )
    )
  ).then((thumbnails) => thumbnails.flat());
  thumbnailsMade.set(submission, making);
  return making;
}

export function neoQuoteExcerpt(text: string): string {
  const chars = Array.from(text.replace(/\r\n?|\u2028|\u2029/g, '\n').trim());
  return chars.length > 500 ? `${chars.slice(0, 500).join('')}…` : chars.join('');
}

export function neoPublicationQuoteExcerpt(publication: Pick<NeoPublication, 'shortText'>): string {
  return neoReplyExcerpt(publication.shortText);
}

export function neoDraftPayload(submission: Submission, thumbnails: readonly NeoThumbnail[] = []) {
  const { sessionId, requestId, images, text } = submission;
  return {
    sessionId,
    requestId,
    content: images?.length
      ? [
          ...(text.trim() ? [{ type: 'text' as const, text }] : []),
          ...images.map((image) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, data: image.data, media_type: image.media_type },
          })),
        ]
      : text,
    ...(images?.length && thumbnails.length ? { thumbnails: [...thumbnails] } : {}),
    ...(submission.quote?.replyTo ? { replyTo: submission.quote.replyTo } : {}),
    ...(submission.previewContext
      ? {
          previewContext: {
            artifactId: submission.previewContext.artifactId,
            snapshot: submission.previewContext.snapshot,
          },
        }
      : {}),
  };
}

export const NEO_UNCONFIRMED_RECEIPT = 'Could not confirm this message. Please try again.';

export function requireNeoReceipt(
  response: unknown,
  submission: Submission
): { value: Extract<IntakeReceipt, { ok: true }> } | { reason: Rejection } {
  if (typeof response === 'object' && response !== null && 'ok' in response) {
    if (response.ok === false && 'reason' in response && typeof response.reason === 'string')
      return { reason: { ok: false, reason: response.reason } };
    const rawContext = 'previewContext' in response ? response.previewContext : undefined;
    const previewContext = readNeoPreviewReference(rawContext);
    const matchingContext = submission.previewContext
      ? previewContext?.artifactId === submission.previewContext.artifactId &&
        previewContext?.snapshot === submission.previewContext.snapshot
      : rawContext === undefined;
    if (
      response.ok === true &&
      'requestId' in response &&
      response.requestId === submission.requestId &&
      'messageId' in response &&
      response.messageId === submission.requestId &&
      'created' in response &&
      typeof response.created === 'boolean' &&
      matchingContext
    )
      return {
        value: {
          ok: true,
          requestId: submission.requestId,
          messageId: submission.requestId,
          created: response.created,
          ...(previewContext ? { previewContext } : {}),
        },
      };
  }
  return { reason: { ok: false, reason: NEO_UNCONFIRMED_RECEIPT } };
}

export const submitNeoDraft = (superpipe({})('neo-submit-draft') as PipelineAPI)
  .input(['submission', 'getHub'])
  .pipe(captureNeoSubmission, 'submission', 'submission')
  .pipe(admitNeoDraft, 'submission', 'result:receipt')
  .pipe(neoDraftThumbnails, 'receipt', 'thumbnails')
  .pipe(neoDraftPayload, ['receipt', 'thumbnails'], 'payload')
  .pipe((getHub: () => Promise<MessageHub>) => getHub(), 'getHub', 'hub')
  .pipe(
    (payload: ReturnType<typeof neoDraftPayload>, hub: MessageHub) =>
      invokeOperation<unknown>(hub, 'neo.message.send', payload, { timeout: NEO_SEND_TIMEOUT_MS }),
    ['payload', 'hub'],
    'response'
  )
  .pipe(requireNeoReceipt, ['response', 'submission'], 'result:receipt')
  .endAsync('receipt') as (
  submission: Submission,
  getHub: () => Promise<MessageHub>
) => Promise<IntakeReceipt>;

function sameDraft(submission: Submission, draft: NeoDraft): boolean {
  const prior = submission.images ?? [];
  const current = draft.images ?? [];
  return (
    submission.sessionId === draft.sessionId &&
    submission.text === draft.text &&
    submission.previewContext?.artifactId === draft.previewContext?.artifactId &&
    submission.previewContext?.snapshot === draft.previewContext?.snapshot &&
    submission.quote?.anchor === draft.quote?.anchor &&
    submission.quote?.text === draft.quote?.text &&
    submission.quote?.author === draft.quote?.author &&
    submission.quote?.replyTo?.kind === draft.quote?.replyTo?.kind &&
    submission.quote?.replyTo?.id === draft.quote?.replyTo?.id &&
    submission.quote?.replyTo?.author === draft.quote?.replyTo?.author &&
    submission.quote?.replyTo?.excerpt === draft.quote?.replyTo?.excerpt &&
    prior.length === current.length &&
    prior.every(
      (image, index) =>
        image.data === current[index].data && image.media_type === current[index].media_type
    )
  );
}

export type NeoPendingAsk = {
  requestId: string;
  sessionId: string;
  text: string;
  images: readonly MessageImage[];
  quote?: NeoQuote;
  previewContext?: NeoPreviewReference;
  createdAt: string;
  state: 'sending' | 'accepted' | 'failed';
  reason?: string;
};

export function createNeoIntakeClient(
  getHub: () => Promise<MessageHub>,
  onPending: (asks: readonly NeoPendingAsk[]) => void = () => {}
) {
  const pending = new Map<string, Set<PendingSubmission>>();
  const shown = new Map<string, NeoPendingAsk>();
  function show(submission: Submission, state: NeoPendingAsk['state'], reason?: string) {
    const { sessionId, text, images, quote, previewContext } = captureNeoDraft(submission);
    shown.set(submission.requestId, {
      requestId: submission.requestId,
      sessionId,
      text,
      images: images ?? [],
      ...(quote ? { quote } : {}),
      ...(previewContext ? { previewContext } : {}),
      createdAt: shown.get(submission.requestId)?.createdAt ?? new Date().toISOString(),
      state,
      ...(reason ? { reason } : {}),
    });
    onPending([...shown.values()]);
  }
  function find(requestId: string) {
    for (const entries of pending.values())
      for (const entry of entries) if (entry.submission.requestId === requestId) return entry;
    return undefined;
  }
  function fly(entry: PendingSubmission): Promise<IntakeReceipt> {
    if (entry.flight) return entry.flight;
    const entries = pending.get(entry.submission.sessionId);
    show(entry.submission, 'sending');
    const flight = submitNeoDraft(entry.submission, getHub)
      .then(
        (receipt) => {
          if (receipt.ok) {
            entries?.delete(entry);
            if (entries && !entries.size && pending.get(entry.submission.sessionId) === entries)
              pending.delete(entry.submission.sessionId);
            show(entry.submission, 'accepted');
          } else show(entry.submission, 'failed', receipt.reason);
          return receipt;
        },
        (error: unknown) => {
          show(entry.submission, 'failed', NEO_UNCONFIRMED_RECEIPT);
          throw error;
        }
      )
      .finally(() => {
        if (entry.flight === flight) entry.flight = undefined;
      });
    entry.flight = flight;
    return flight;
  }
  function send(draft: NeoDraft): Promise<IntakeReceipt> {
    const admission = admitNeoDraft(draft);
    if ('reason' in admission) return Promise.resolve(admission.reason);
    const entries = pending.get(draft.sessionId) ?? new Set<PendingSubmission>();
    let entry = [...entries].find((item) => sameDraft(item.submission, draft));
    if (!entry) {
      entry = {
        submission: {
          ...captureNeoDraft(draft),
          requestId: generateUUID(),
        },
      };
      intakeSubmissions.add(entry.submission);
      entries.add(entry);
      pending.set(draft.sessionId, entries);
    }
    return fly(entry);
  }
  function retry(requestId: string): Promise<IntakeReceipt> | null {
    const entry = find(requestId);
    return entry ? fly(entry) : null;
  }
  function discard(requestId: string): NeoDraft | null {
    const entry = find(requestId);
    if (!entry || entry.flight) return null;
    pending.get(entry.submission.sessionId)?.delete(entry);
    shown.delete(requestId);
    onPending([...shown.values()]);
    const { sessionId, text, images, quote, previewContext } = entry.submission;
    return {
      sessionId,
      text,
      images,
      ...(quote ? { quote } : {}),
      ...(previewContext ? { previewContext } : {}),
    };
  }
  function settle(delivered: ReadonlySet<string>) {
    let changed = false;
    for (const [requestId, ask] of shown)
      if (ask.state === 'accepted' && delivered.has(requestId)) {
        shown.delete(requestId);
        changed = true;
      }
    if (changed) onPending([...shown.values()]);
  }
  function requestIdFor(draft: NeoDraft): string | null {
    const entries = pending.get(draft.sessionId);
    return (
      [...(entries ?? [])].find((item) => sameDraft(item.submission, draft))?.submission
        .requestId ?? null
    );
  }
  return {
    send,
    retry,
    discard,
    settle,
    requestIdFor,
    snapshots: { ...neoIntakeSnapshots, storage: createNeoIntakeStorage },
  };
}
