import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import { isNeoCoordinatorBinding } from './binding-roles.ts';

export interface NeoAskOrigin {
  readonly sessionId: string;
  readonly messageId: string;
}
type Input = { readonly sessionId: string; readonly messageId: string | null };
type Stop = { kind: 'unknown' } | { kind: 'human'; origin: NeoAskOrigin };
type Gate = { value: NeoAskOrigin } | { reason: Stop };
export interface NeoAskOriginReads {
  getBinding(sessionId: string): NeoBinding | null;
  getPrompts(sessionId: string, messageId: string): readonly SDKMessage[];
  getStamp(sessionId: string, messageId: string): NeoAskOrigin | null;
}
const unknown: Stop = { kind: 'unknown' };
const NUDGE_PREFIX = 'neo-nudge:';

export const NEO_ASK_ANSWER_PREFIX = 'neo-ask-answer:';

export function neoDoneCheckMessageId(
  workId: string,
  continued: number,
  prRevision?: number,
  followedAt?: number,
  stalled = 0
): string {
  return `${workId}:done-check:${continued}${prRevision ? `:pr:${prRevision}` : ''}${followedAt ? `:at:${followedAt}` : ''}${stalled > 0 ? `:s:${stalled}` : ''}`;
}

const NEO_FOLDABLE_NOTE =
  /^neo-ask-evidence:|^neo-session-notices:|^neo-card-pr:|:stall:\d+$|:needs-you:\d+$/;

export function isNeoFoldableNote(messageId: string): boolean {
  return NEO_FOLDABLE_NOTE.test(messageId);
}

export function neoWorkReturnMessageId(workId: string, retries: number, continued = 0): string {
  const base = retries ? `${workId}:retry:${retries}` : workId;
  return continued ? `${base}:continued:${continued}` : base;
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

export function requireNeoAskUnstamped(
  input: NeoAskOrigin,
  stamped: { origin: NeoAskOrigin | null }
): Gate {
  return stamped.origin ? { reason: { kind: 'human', origin: stamped.origin } } : { value: input };
}

export function createNeoAskOriginResolver(reads: NeoAskOriginReads) {
  const resolve = (superpipe({})('neo-ask-origin') as PipelineAPI)
    .input('input')
    .pipe(requireNeoAskReference, 'input', 'result:step')
    .pipe(
      (input: NeoAskOrigin) => ({
        origin: reads.getStamp(input.sessionId, input.messageId) ?? null,
      }),
      'step',
      'stamped'
    )
    .pipe(requireNeoAskUnstamped, ['step', 'stamped'], 'result:step')
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
    .pipe((): Stop => unknown, 'step', 'step')
    .end('step') as (input: Input) => Stop;
  return (input: Input): NeoAskOrigin | null => {
    const stop = resolve(input);
    return stop.kind === 'human' ? stop.origin : null;
  };
}
