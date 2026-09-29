import type { ChatMessage } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { selectNeoReplyOrigin } from './reply-context.ts';

export type NeoRequestOrigin = { sessionId: string; messageId: string };
type Selection = { snapshot: NeoSnapshot; origin: NeoRequestOrigin };
type Gate<T> = { value: T } | { reason: null };
const key = (kind: string, id: string) => JSON.stringify([kind, id]);

export function neoRequestOrigin(message: ChatMessage, sessionId: string): NeoRequestOrigin | null {
  if (
    !sessionId.trim() ||
    !message.uuid?.trim() ||
    ('parent_tool_use_id' in message && message.parent_tool_use_id)
  )
    return null;
  if (message.type === 'user' && (message as { inputKind?: string }).inputKind !== 'system')
    return { sessionId, messageId: message.uuid };
  const selected = selectNeoReplyOrigin(message, sessionId);
  return 'value' in selected
    ? { sessionId: selected.value.sessionId, messageId: selected.value.messageId }
    : null;
}

export function selectNeoRequestSnapshot(
  snapshot: NeoSnapshot | null,
  origin: unknown
): Gate<Selection> {
  if (
    !snapshot ||
    !Array.isArray(snapshot.askOrigins) ||
    !origin ||
    typeof origin !== 'object' ||
    Array.isArray(origin)
  )
    return { reason: null };
  const ref = origin as Partial<NeoRequestOrigin>;
  if (
    typeof ref.sessionId !== 'string' ||
    !ref.sessionId.trim() ||
    snapshot.sessionId !== ref.sessionId ||
    typeof ref.messageId !== 'string' ||
    !ref.messageId.trim()
  )
    return { reason: null };
  return { value: { snapshot, origin: { sessionId: ref.sessionId, messageId: ref.messageId } } };
}

export function scopeNeoRequestReceipts({ snapshot, origin }: Selection): Gate<NeoSnapshot> {
  const origins = new Map<string, NeoRequestOrigin | null>();
  for (const row of snapshot.askOrigins ?? []) {
    if (!row || !['work', 'consultation'].includes(row.kind) || typeof row.id !== 'string')
      continue;
    const ref = key(row.kind, row.id);
    origins.set(ref, origins.has(ref) ? null : row.origin);
  }
  const matches = (kind: string, id: string) => {
    const ref = origins.get(key(kind, id));
    return ref?.sessionId === origin.sessionId && ref?.messageId === origin.messageId;
  };
  const work = snapshot.work.filter((item) => matches('work', item.id));
  const consultations = (snapshot.consultations ?? []).filter((item) =>
    matches('consultation', item.id)
  );
  const consultationWaiters = (snapshot.consultationWaiters ?? []).filter(
    (item) =>
      item.status === 'queued' &&
      matches('consultation', item.id) &&
      !consultations.some((active) => active.id === item.id)
  );
  if (!work.length && !consultations.length && !consultationWaiters.length) return { reason: null };
  const concerns = new Set(
    [...work, ...consultations, ...consultationWaiters].map((item) => item.concernId)
  );
  return {
    value: {
      ...snapshot,
      concerns: snapshot.concerns.filter((item) => concerns.has(item.id)),
      work,
      consultations,
      consultationWaiters,
      workResources: snapshot.workResources?.filter((row) =>
        work.some((item) => item.id === row.workId)
      ),
      askOrigins: snapshot.askOrigins?.filter((row) => matches(row.kind, row.id)),
    },
  };
}

export function neoRequestConsultationProgress(snapshot: NeoSnapshot | null) {
  return [
    ...(snapshot?.consultations ?? []).filter((item) => item.status === 'pending'),
    ...(snapshot?.consultationWaiters ?? []).filter(
      (item) =>
        item.status === 'queued' &&
        !snapshot?.consultations?.some((active) => active.id === item.id)
    ),
  ].map((item) => {
    const title = snapshot?.concerns.find((concern) => concern.id === item.concernId)?.title;
    return {
      id: item.id,
      status: item.status,
      label: `${item.status === 'queued' ? 'Waiting for' : 'Checking'} ${title ? `${title}’s context` : 'context'}…`,
    };
  });
}

export const projectNeoRequestSnapshot = (superpipe({})('neo-request-board') as PipelineAPI)
  .input(['snapshot', 'origin'])
  .pipe(selectNeoRequestSnapshot, ['snapshot', 'origin'], 'result:scope')
  .pipe(scopeNeoRequestReceipts, 'scope', 'result:scope')
  .end('scope') as (snapshot: NeoSnapshot | null, origin: unknown) => NeoSnapshot | null;
