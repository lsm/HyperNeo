import type { MessageHub, MessageImage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../lib/operations.ts';

export type NeoDraft = { sessionId: string; text: string; images?: readonly MessageImage[] };
type Submission = NeoDraft & { requestId: string };
type IntakeReceipt =
  | { ok: true; requestId: string; messageId: string; created: boolean }
  | { ok: false; reason: string };
type Rejection = Extract<IntakeReceipt, { ok: false }>;

export function admitNeoDraft(
  submission: Submission
): { value: Submission } | { reason: Rejection } {
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
  return { reason: { ok: false, reason: 'Could not confirm this message. Please try again.' } };
}

const submitNeoDraft = (superpipe({})('neo-submit-draft') as PipelineAPI)
  .input(['submission', 'getHub'])
  .pipe(admitNeoDraft, 'submission', 'result:receipt')
  .pipe(neoDraftPayload, 'receipt', 'payload')
  .pipe((getHub: () => Promise<MessageHub>) => getHub(), 'getHub', 'hub')
  .pipe(
    (payload: ReturnType<typeof neoDraftPayload>, hub: MessageHub) =>
      invokeOperation<unknown>(hub, 'neo.message.send', payload),
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

export function createNeoIntakeClient(getHub: () => Promise<MessageHub>) {
  const pending = new Map<string, { submission: Submission; flight?: Promise<IntakeReceipt> }>();
  function send(draft: NeoDraft): Promise<IntakeReceipt> {
    let entry = pending.get(draft.sessionId);
    if (!entry || !sameDraft(entry.submission, draft)) {
      entry = {
        submission: {
          ...draft,
          images: draft.images?.map((image) => ({ ...image })),
          requestId: crypto.randomUUID(),
        },
      };
      pending.set(draft.sessionId, entry);
    }
    if (entry.flight) return entry.flight;
    const current = entry;
    const flight = submitNeoDraft(current.submission, getHub)
      .then((receipt) => {
        if (receipt.ok && pending.get(current.submission.sessionId) === current)
          pending.delete(current.submission.sessionId);
        return receipt;
      })
      .finally(() => {
        if (current.flight === flight) current.flight = undefined;
      });
    current.flight = flight;
    return flight;
  }
  return { send };
}
