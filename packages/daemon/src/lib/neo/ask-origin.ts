import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { hashString32 } from '../runtime-hash.ts';
import { isMainNeoBinding, isNeoCoordinatorBinding } from './binding-roles.ts';

export interface NeoAskOrigin {
  readonly sessionId: string;
  readonly messageId: string;
}
type Input = { readonly sessionId: string; readonly messageId: string | null };
type Stop = { kind: 'unknown' } | { kind: 'human'; origin: NeoAskOrigin };
type Hop = Stop | { kind: 'parent'; origin: NeoAskOrigin };
type Gate = { value: NeoAskOrigin } | { reason: Stop };
type NeoAskOriginAsk = Pick<NeoAsk, 'id' | 'originSessionId' | 'originMessageId'>;
export interface NeoAskOriginReads {
  getBinding(sessionId: string): NeoBinding | null;
  getPrompts(sessionId: string, messageId: string): readonly SDKMessage[];
  getConsultation(id: string): NeoConsultation | null;
  getWork(id: string): NeoWork | null;
  getAsk(id: string): NeoAskOriginAsk | null;
  getRootBinding(): NeoBinding | null;
  getStamp?(sessionId: string, messageId: string): NeoAskOrigin | null;
  stamp?(input: NeoAskOrigin, origin: NeoAskOrigin): void;
}
export interface NeoAskEvidence {
  envelope: 'request' | 'reply' | null;
  consultation: NeoConsultation | null;
  work: NeoWork | null;
  ask: NeoAskOriginAsk | null;
  root: NeoBinding | null;
  holder: NeoBinding | null;
  workOrigin: NeoBinding | null;
}
const unknown: Stop = { kind: 'unknown' };
const NUDGE_PREFIX = 'neo-nudge:';

export function neoAskEvidenceMessageId(askId: string, signature: string): string {
  return `neo-ask-evidence:${askId}:${hashString32(signature).toString(36)}`;
}

export function neoAskAnswerMessageId(askId: string, itemId: string, at: number): string {
  return `neo-ask-answer:${askId}:${itemId}:${at}`;
}

export function neoAskEvidenceAskId(messageId: string): string | null {
  return /^neo-ask-evidence:(.+):[0-9a-z]+$/.exec(messageId)?.[1] ?? null;
}

export function neoWorkParent(
  work: Pick<NeoWork, 'originSessionId' | 'originMessageId'>
): NeoAskOrigin | null {
  return work.originMessageId
    ? { sessionId: work.originSessionId, messageId: work.originMessageId }
    : null;
}

export function neoAskParent(ask: NeoAskOriginAsk): NeoAskOrigin | null {
  return ask.originMessageId
    ? { sessionId: ask.originSessionId, messageId: ask.originMessageId }
    : null;
}

export function neoConsultationParent(
  item: Pick<NeoConsultation, 'originSessionId' | 'originMessageId'>
): NeoAskOrigin | null {
  return item.originMessageId
    ? { sessionId: item.originSessionId, messageId: item.originMessageId }
    : null;
}

export function neoNudgeMessageId(messageId: string): string {
  return `${NUDGE_PREFIX}${messageId}`;
}

export function neoDoneCheckMessageId(
  workId: string,
  continued: number,
  prRevision?: number,
  followedAt?: number
): string {
  return `${workId}:done-check:${continued}${prRevision ? `:pr:${prRevision}` : ''}${followedAt ? `:at:${followedAt}` : ''}`;
}

export function neoStallMessageId(workId: string, since: number): string {
  return `${workId}:stall:${since}`;
}

export function neoNeedsYouMessageId(workId: string, at: number): string {
  return `${workId}:needs-you:${at}`;
}

export function neoWorkReturnMessageId(workId: string, retries: number, continued = 0): string {
  const base = retries ? `${workId}:retry:${retries}` : workId;
  return continued ? `${base}:continued:${continued}` : base;
}

export function neoWorkReviewId(workId: string, retries: number, continued = 0): string {
  return `neo-work:${workId}:review${retries ? `:retry:${retries}` : ''}${continued ? `:continued:${continued}` : ''}`;
}

function checkedWorkId(messageId: string): string {
  return (
    /^(.+?)(?::(?:done-check|stall|needs-you|retry|continued):\d+)+(?::pr:\d+)?(?::at:\d+)?$/.exec(
      messageId
    )?.[1] ?? messageId
  );
}

function settledOrStalled(work: NeoWork, messageId: string): boolean {
  return (
    work.status === 'reported' ||
    work.status === 'failed' ||
    (work.status === 'queued' && /:(?:stall|needs-you):\d+$/.test(messageId))
  );
}

export function nudgedMessageId(messageId: string): string | null {
  return messageId.startsWith(NUDGE_PREFIX) ? messageId.slice(NUDGE_PREFIX.length) || null : null;
}

export function requireNeoAskReference(input: Input): Gate {
  return input.sessionId && input.messageId
    ? { value: { sessionId: input.sessionId, messageId: input.messageId } }
    : { reason: unknown };
}

export function requireNeoAskCoordinator(input: NeoAskOrigin, binding: NeoBinding | null): Gate {
  return binding?.sessionId === input.sessionId && isNeoCoordinatorBinding(binding)
    ? { value: input }
    : { reason: unknown };
}

export function classifyNeoAskInput(input: NeoAskOrigin, prompts: readonly SDKMessage[]): Gate {
  if (
    !prompts.length ||
    !prompts.every(
      (message) =>
        message.type === 'user' &&
        message.session_id === input.sessionId &&
        message.uuid === input.messageId &&
        'inputKind' in message
    )
  )
    return { reason: unknown };
  if (prompts.every((message) => 'inputKind' in message && message.inputKind === 'human'))
    return { reason: { kind: 'human', origin: { ...input } } };
  return prompts.every((message) => 'inputKind' in message && message.inputKind === 'system')
    ? { value: input }
    : { reason: unknown };
}

function reviewWorkId(id: string): string | null {
  return /^neo-work:(.+):review(?::retry:\d+)?(?::continued:\d+)?$/.exec(id)?.[1] ?? null;
}

export function readNeoAskEvidence(input: NeoAskOrigin, reads: NeoAskOriginReads): NeoAskEvidence {
  const envelope = input.messageId.startsWith('neo-consult:')
    ? input.messageId.endsWith(':request')
      ? 'request'
      : input.messageId.endsWith(':reply')
        ? 'reply'
        : null
    : null;
  const id = envelope ? input.messageId.slice('neo-consult:'.length, -(envelope.length + 1)) : null;
  const consultation = id ? (reads.getConsultation(id) ?? null) : null;
  const askId = envelope ? null : neoAskEvidenceAskId(input.messageId);
  const workId = id ? reviewWorkId(id) : askId ? null : checkedWorkId(input.messageId);
  const work = workId ? (reads.getWork(workId) ?? null) : null;
  return {
    envelope,
    consultation,
    work,
    ask: askId ? (reads.getAsk(askId) ?? null) : null,
    root: reads.getRootBinding() ?? null,
    holder: consultation ? (reads.getBinding(consultation.sessionId) ?? null) : null,
    workOrigin: work ? (reads.getBinding(work.originSessionId) ?? null) : null,
  };
}

function validWorkOrigin(work: NeoWork, evidence: NeoAskEvidence): boolean {
  const binding = evidence.workOrigin;
  return (
    binding?.sessionId === work.originSessionId &&
    ((isMainNeoBinding(binding) && binding.sessionId === evidence.root?.sessionId) ||
      (binding.kind === 'concern' &&
        binding.concernId !== null &&
        binding.concernId === work.concernId))
  );
}

export function selectNeoAskParent(input: NeoAskOrigin, evidence: NeoAskEvidence): Hop {
  const { root, holder, consultation, work, envelope } = evidence;
  if (!isMainNeoBinding(root)) return unknown;
  const nudged = nudgedMessageId(input.messageId);
  if (nudged) return { kind: 'parent', origin: { sessionId: input.sessionId, messageId: nudged } };
  if (!envelope && evidence.ask) {
    const { ask } = evidence;
    return neoAskEvidenceAskId(input.messageId) === ask.id &&
      input.sessionId === ask.originSessionId &&
      ask.originMessageId
      ? {
          kind: 'parent',
          origin: { sessionId: ask.originSessionId, messageId: ask.originMessageId },
        }
      : unknown;
  }
  if (!envelope) {
    return work?.id === checkedWorkId(input.messageId) &&
      settledOrStalled(work, input.messageId) &&
      (input.sessionId === root.sessionId || input.sessionId === work.originSessionId) &&
      validWorkOrigin(work, evidence) &&
      work.originMessageId
      ? {
          kind: 'parent',
          origin: { sessionId: work.originSessionId, messageId: work.originMessageId },
        }
      : unknown;
  }
  if (
    !consultation ||
    input.messageId !== `neo-consult:${consultation.id}:${envelope}` ||
    consultation.originSessionId !== root.sessionId ||
    holder?.kind !== 'concern' ||
    holder.sessionId !== consultation.sessionId ||
    holder.concernId !== consultation.concernId ||
    input.sessionId !== (envelope === 'request' ? holder.sessionId : root.sessionId) ||
    (envelope === 'reply' && consultation.status === 'pending')
  )
    return unknown;
  const reviewId = reviewWorkId(consultation.id);
  if (!reviewId)
    return consultation.originMessageId
      ? {
          kind: 'parent',
          origin: { sessionId: root.sessionId, messageId: consultation.originMessageId },
        }
      : unknown;
  return work?.id === reviewId &&
    (work.status === 'reported' || work.status === 'failed') &&
    consultation.requestKey === consultation.id &&
    consultation.originMessageId === null &&
    work.concernId === consultation.concernId &&
    validWorkOrigin(work, evidence) &&
    work.originMessageId
    ? {
        kind: 'parent',
        origin: { sessionId: work.originSessionId, messageId: work.originMessageId },
      }
    : unknown;
}

export function createNeoAskOriginResolver(reads: NeoAskOriginReads) {
  const hop = (superpipe({})('neo-ask-origin-hop') as PipelineAPI)
    .input('input')
    .pipe(requireNeoAskReference, 'input', 'result:step')
    .pipe(
      (input: NeoAskOrigin) => ({ binding: reads.getBinding(input.sessionId) ?? null }),
      'step',
      'binding'
    )
    .pipe(
      (input: NeoAskOrigin, { binding }: { binding: NeoBinding | null }) =>
        requireNeoAskCoordinator(input, binding),
      ['step', 'binding'],
      'result:step'
    )
    .pipe(
      (input: NeoAskOrigin) => reads.getPrompts(input.sessionId, input.messageId),
      'step',
      'prompts'
    )
    .pipe(classifyNeoAskInput, ['step', 'prompts'], 'result:step')
    .pipe((input: NeoAskOrigin) => readNeoAskEvidence(input, reads), 'step', 'evidence')
    .pipe(selectNeoAskParent, ['step', 'evidence'], 'step')
    .end('step') as (input: Input) => Hop;
  return (input: Input): NeoAskOrigin | null => {
    const stamped = input.messageId ? reads.getStamp?.(input.sessionId, input.messageId) : null;
    if (stamped) return stamped;
    let cursor = input;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      const key = JSON.stringify([cursor.sessionId, cursor.messageId]);
      if (visited.has(key)) return null;
      visited.add(key);
      const step = hop(cursor);
      if (step.kind === 'human') {
        if (depth > 0 && input.messageId)
          reads.stamp?.({ sessionId: input.sessionId, messageId: input.messageId }, step.origin);
        return step.origin;
      }
      if (step.kind === 'unknown') return null;
      cursor = step.origin;
    }
    return null;
  };
}
