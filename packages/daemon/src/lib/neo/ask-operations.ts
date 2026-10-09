import type { NeoConcern } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';
import { admitNeoWorkOrigin, type NeoWorkOrigin } from './work-origin.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type NeoAdmit = (
  caller: OperationCaller,
  name: string,
  concernId?: string | null
) => Gate<OperationCaller>;
type AskReceipt = { ok: true; ask: NeoAsk };

const Failure = z.object({ ok: z.literal(false), reason: z.string() });
export const NeoAskSchema = z.object({
  id: z.string(),
  requestKey: z.string(),
  concernId: z.string().nullable(),
  originSessionId: z.string(),
  originMessageId: z.string().nullable(),
  title: z.string(),
  ask: z.string(),
  doneWhen: z.string(),
  doneSource: z.string(),
  status: z.enum(['open', 'waiting', 'achieved', 'abandoned', 'blocked']),
  outcome: z.string().nullable(),
  workIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  settledAt: z.number().nullable(),
});
const AskResult = z.union([Failure, z.object({ ok: z.literal(true), ask: NeoAskSchema })]);
const Open = z.object({
  requestKey: z.string().min(1).max(160),
  concernId: z.string().min(1).nullable().default(null),
  title: z.string().trim().min(1).max(160),
  ask: z.string().trim().min(1).max(4000),
  doneWhen: z.string().trim().min(1).max(2000),
  doneSource: z.string().trim().min(1).max(160),
});

const fail = (reason: string): Rejection => ({ ok: false, reason });
const isFinal = (ask: NeoAsk) => ask.status === 'achieved' || ask.status === 'abandoned';
const ACTIVE_ASK_LIMIT = 50;

export function requireNeoWorkAsk<T>(
  ask: NeoAsk | null,
  input: { askId?: string; concernId: string | null },
  value: T
): Gate<T> {
  if (!input.askId) return { value };
  if (!ask) return { reason: fail('ask_not_found') };
  if (ask.concernId !== input.concernId)
    return { reason: fail('This ask belongs to another concern; propose under its concernId.') };
  return isFinal(ask)
    ? { reason: fail(`ask_settled: this ask is already ${ask.status}; open a new ask.`) }
    : { value };
}

export function requireNeoWorkAskLink<T>(
  input: { askId?: string },
  link: { owner: string | null },
  value: T
): Gate<T> {
  return !input.askId || link.owner === input.askId
    ? { value }
    : {
        reason: fail('This request key already belongs to work under another ask; use a new one.'),
      };
}

export function projectNeoSnapshotAsks(asks: readonly NeoAsk[], settledLimit: number): NeoAsk[] {
  const active = asks.filter((ask) => !isFinal(ask)).slice(0, ACTIVE_ASK_LIMIT);
  return [...active, ...asks.filter(isFinal).slice(0, settledLimit)];
}

export function requireNeoAskConcern<T>(
  input: { concernId: string | null },
  found: { concern: NeoConcern | null },
  value: T
): Gate<T> {
  return input.concernId && !found.concern ? { reason: fail('Concern not found.') } : { value };
}

export function requireNeoAskReceipt(
  input: z.infer<typeof Open>,
  opened: { ask: NeoAsk | null }
): Gate<AskReceipt> {
  const { ask } = opened;
  if (!ask) return { reason: fail('Asks are not available on this daemon yet.') };
  const same = (['concernId', 'title', 'ask', 'doneWhen', 'doneSource'] as const).every(
    (field) => ask[field] === input[field]
  );
  return same
    ? { value: { ok: true, ask } }
    : { reason: fail('This request key already belongs to another ask.') };
}

export function createNeoAskOperations(service: NeoService, admit: NeoAdmit) {
  const open = (superpipe({})('neo.ask.open') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Open>, caller: OperationCaller) =>
        admit(caller, 'neo.ask.open', input.concernId),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Open>) => ({
        concern: input.concernId ? service.repo.getConcern(input.concernId) : null,
      }),
      'input',
      'concern'
    )
    .pipe(requireNeoAskConcern, ['input', 'concern', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Open>, caller: OperationCaller) =>
        admitNeoWorkOrigin(
          caller,
          caller.sessionId ?? service.repo.getBindingForConcern(input.concernId)?.sessionId
        ),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Open>, origin: NeoWorkOrigin) => ({
        ask: service.askRecords.open({
          ...input,
          ...origin,
          id: crypto.randomUUID(),
          requestKey: `${origin.originSessionId}:${input.requestKey}`,
        }),
      }),
      ['input', 'admission'],
      'opened'
    )
    .pipe(requireNeoAskReceipt, ['input', 'opened'], 'result:admission')
    .end('admission') as (
    input: z.infer<typeof Open>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;
  return [
    defineOperation({
      name: 'neo.ask.open',
      description:
        'Record what the human asked for and what done means for it, from the current live input, before proposing its work. ask is the request in their words; doneWhen is the outcome that finishes it (for code, usually merged and not just a pull request opened); doneSource is "human" when the human said it, or the id of the standing rule it came from. Propose every card for this request with its askId. Reuse requestKey only to retry this input.',
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => open(input, caller),
    }),
  ];
}
