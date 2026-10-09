import type { NeoConcern, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskInput } from '../../storage/repositories/neo-ask-repository.ts';
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
  evidence: z.string().nullable().optional(),
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
const Settle = z.object({
  id: z.string().min(1),
  outcome: z.enum(['achieved', 'abandoned', 'blocked']),
  summary: z.string().trim().min(1).max(200).optional(),
  evidence: z.string().trim().min(1).max(4000),
});

const fail = (reason: string): Rejection => ({ ok: false, reason });
const isFinal = (ask: NeoAsk) => ask.status === 'achieved' || ask.status === 'abandoned';
const ACTIVE_ASK_LIMIT = 50;

export function requireNeoWorkAsk(
  ask: NeoAsk | null,
  input: { askId?: string; concernId: string | null },
  caller: OperationCaller
): Gate<OperationCaller> {
  if (!input.askId) return { value: caller };
  if (!ask) return { reason: fail('ask_not_found') };
  if (ask.concernId !== input.concernId)
    return { reason: fail('This ask belongs to another concern; propose under its concernId.') };
  if (caller.source === 'mcp' && caller.sessionId !== ask.originSessionId)
    return {
      reason: fail(
        'Only the Neo session that opened this ask files work under it; open your own ask.'
      ),
    };
  return isFinal(ask)
    ? { reason: fail(`ask_settled: this ask is already ${ask.status}; open a new ask.`) }
    : { value: caller };
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

export function planNeoCardAsk(
  input: {
    askId?: string;
    requestKey: string;
    concernId: string | null;
    title: string;
    goal?: string;
    doneWhen?: string;
  },
  origin: NeoWorkOrigin
): Omit<NeoAskInput, 'id'> | null {
  if (input.askId || !input.doneWhen) return null;
  return {
    requestKey: `card:${origin.originSessionId}:${input.requestKey}`,
    concernId: input.concernId,
    originSessionId: origin.originSessionId,
    originMessageId: origin.originMessageId,
    title: input.title,
    ask: input.goal ?? input.title,
    doneWhen: input.doneWhen,
    doneSource: 'card',
  };
}

export function isNeoCardAsk(ask: NeoAsk | null, planned: Omit<NeoAskInput, 'id'>): boolean {
  return (
    !!ask &&
    (Object.keys(planned) as (keyof typeof planned)[]).every(
      (field) => ask[field] === planned[field]
    )
  );
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

export const neoAskSummary = (input: z.infer<typeof Settle>) => input.summary ?? input.evidence;

export const isNeoAskReplay = (ask: NeoAsk, input: z.infer<typeof Settle>) =>
  ask.status === input.outcome &&
  ask.outcome === neoAskSummary(input) &&
  (ask.evidence ?? ask.outcome) === input.evidence;

export function requireNeoAskSummary(
  input: z.infer<typeof Settle>,
  caller: OperationCaller
): Gate<OperationCaller> {
  return caller.source === 'mcp' && !input.summary
    ? {
        reason: fail(
          'summary_required: pass summary, one short sentence the card shows ("Merged in #6099."), and keep the proof in evidence.'
        ),
      }
    : { value: caller };
}

export function requireNeoAskSettlement(
  input: z.infer<typeof Settle>,
  current: { ask: NeoAsk | null },
  caller: OperationCaller
): Gate<NeoAsk> {
  const { ask } = current;
  if (!ask) return { reason: fail('ask_not_found') };
  if (caller.source === 'mcp' && caller.sessionId !== ask.originSessionId)
    return {
      reason: fail('Only the Neo session that opened this ask or the user can settle it.'),
    };
  return isFinal(ask) && !isNeoAskReplay(ask, input)
    ? { reason: fail(`ask_settled: this ask is already ${ask.status}.`) }
    : { value: ask };
}

export function requireNeoAskWritten(written: { ask: NeoAsk | null }): Gate<AskReceipt> {
  return written.ask
    ? { value: { ok: true, ask: written.ask } }
    : { reason: fail('This ask changed; read it again.') };
}

export function planNeoAskWorkStops(
  works: readonly Pick<NeoWork, 'id' | 'status'>[],
  outcome: z.infer<typeof Settle>['outcome']
): { id: string; close: 'done' | 'cancelled' }[] {
  if (outcome === 'blocked') return [];
  return works.flatMap((work) =>
    work.status === 'queued'
      ? [
          {
            id: work.id,
            close: outcome === 'achieved' ? ('done' as const) : ('cancelled' as const),
          },
        ]
      : work.status === 'proposed'
        ? [{ id: work.id, close: 'cancelled' as const }]
        : []
  );
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
  const settle = (superpipe({})('neo.ask.settle') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Settle>) => ({ ask: service.askRecords.get(input.id) }),
      'input',
      'current'
    )
    .pipe(
      (caller: OperationCaller, current: { ask: NeoAsk | null }) =>
        admit(caller, 'neo.ask.settle', current.ask?.concernId),
      ['caller', 'current'],
      'result:admission'
    )
    .pipe(requireNeoAskSummary, ['input', 'admission'], 'result:admission')
    .pipe(requireNeoAskSettlement, ['input', 'current', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Settle>, ask: NeoAsk) => ({
        ask: isNeoAskReplay(ask, input)
          ? ask
          : service.askRecords.settle(ask, input.outcome, neoAskSummary(input), input.evidence),
      }),
      ['input', 'admission'],
      'written'
    )
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .pipe(
      (input: z.infer<typeof Settle>, receipt: AskReceipt) =>
        planNeoAskWorkStops(
          receipt.ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []),
          input.outcome
        ),
      ['input', 'admission'],
      'stops'
    )
    .pipe(
      async (stops: { id: string; close: 'done' | 'cancelled' }[]) => {
        for (const stop of stops) await service.close(stop.id, stop.close);
        return stops.length;
      },
      'stops',
      'stopped'
    )
    .endAsync('admission') as (
    input: z.infer<typeof Settle>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;
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
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'Settle an ask when its outcome is decided: achieved when every doneWhen item is met; blocked when only the human can unblock it; abandoned when it is no longer wanted. summary is one short sentence the ask card shows: the outcome, or for blocked what the human must decide ("Merged in #6099.", "Needs you: pick the release date."). evidence holds the proof (PR state, commits, checks), which the card does not show. Achieved and abandoned are final and stop the ask\'s live work: queued cards close (done for achieved, cancelled for abandoned) and proposed cards are cancelled. Proposing new work under a blocked ask reopens it. Only the Neo session that opened the ask or the user can settle it; the user\'s close button calls this too.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => settle(input, caller),
    }),
  ];
}
