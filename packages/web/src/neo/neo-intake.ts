import type { MessageHub, MessageImage } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../lib/operations.ts';
export const NEO_SEND_TIMEOUT_MS = 90_000;

export type NeoDraft = { sessionId: string; text: string; images?: readonly MessageImage[] };
type Submission = NeoDraft & { requestId: string };
type PendingSubmission = { submission: Submission; flight?: Promise<IntakeReceipt> };
type IntakeReceipt =
  | { ok: true; requestId: string; messageId: string; created: boolean }
  | { ok: false; reason: string };
type Rejection = Extract<IntakeReceipt, { ok: false }>;

export function admitNeoDraft<T extends NeoDraft>(
  submission: T
): { value: T } | { reason: Rejection } {
  if (!submission.sessionId || (!submission.text.trim() && !submission.images?.length))
    return { reason: { ok: false, reason: 'Add a message or attachment before sending.' } };
  return { value: submission };
}

export function neoDraftPayload(submission: Submission) {
  const { sessionId, requestId, text, images } = submission;
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
    if (
      response.ok === true &&
      'requestId' in response &&
      response.requestId === submission.requestId &&
      'messageId' in response &&
      response.messageId === submission.requestId &&
      'created' in response &&
      typeof response.created === 'boolean'
    )
      return {
        value: {
          ok: true,
          requestId: submission.requestId,
          messageId: submission.requestId,
          created: response.created,
        },
      };
  }
  return { reason: { ok: false, reason: NEO_UNCONFIRMED_RECEIPT } };
}

export const submitNeoDraft = (superpipe({})('neo-submit-draft') as PipelineAPI)
  .input(['submission', 'getHub'])
  .pipe(admitNeoDraft, 'submission', 'result:receipt')
  .pipe(neoDraftPayload, 'receipt', 'payload')
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
    shown.set(submission.requestId, {
      requestId: submission.requestId,
      sessionId: submission.sessionId,
      text: submission.text,
      images: submission.images ?? [],
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
          ...draft,
          images: draft.images?.map((image) => ({ ...image })),
          requestId: generateUUID(),
        },
      };
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
    const { sessionId, text, images } = entry.submission;
    return { sessionId, text, images };
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
  return { send, retry, discard, settle, requestIdFor };
}
