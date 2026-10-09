import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoService } from './service.ts';
import { admitNeoWorkOrigin } from './work-origin.ts';

type Rejection = { ok: false; reason: string };
type NeoPath = <I, O>(
  name: string,
  scope: (input: I) => string | null | undefined,
  action: (input: I, caller: OperationCaller) => O | Promise<O>
) => (input: I, caller: OperationCaller) => Promise<O | Rejection>;

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
const Settle = z.object({
  id: z.string().min(1),
  outcome: z.enum(['achieved', 'abandoned', 'blocked']),
  evidence: z.string().trim().min(1).max(4000),
});

const fail = (reason: string): Rejection => ({ ok: false, reason });
const isFinal = (ask: NeoAsk) => ask.status === 'achieved' || ask.status === 'abandoned';
const ACTIVE_ASK_LIMIT = 50;

export function requireNeoWorkAsk<T>(
  ask: NeoAsk | null,
  input: { askId?: string; concernId: string | null },
  value: T
): { value: T } | { reason: Rejection } {
  if (!input.askId) return { value };
  if (!ask) return { reason: fail('ask_not_found') };
  if (ask.concernId !== input.concernId)
    return { reason: fail('This ask belongs to another concern; propose under its concernId.') };
  return isFinal(ask)
    ? { reason: fail(`ask_settled: this ask is already ${ask.status}; open a new ask.`) }
    : { value };
}

export function projectNeoSnapshotAsks(asks: readonly NeoAsk[], settledLimit: number): NeoAsk[] {
  const active = asks.filter((ask) => !isFinal(ask)).slice(0, ACTIVE_ASK_LIMIT);
  return [...active, ...asks.filter(isFinal).slice(0, settledLimit)];
}

export function createNeoAskOperations(service: NeoService, path: NeoPath) {
  const open = path(
    'neo.ask.open',
    (input: z.infer<typeof Open>) => input.concernId,
    (input, caller) => {
      if (input.concernId && !service.repo.getConcern(input.concernId))
        return fail('Concern not found.');
      const origin = admitNeoWorkOrigin(
        caller,
        caller.sessionId ?? service.repo.getBindingForConcern(input.concernId)?.sessionId
      );
      if ('reason' in origin) return origin.reason;
      const ask = service.askRecords.open({
        ...input,
        ...origin.value,
        id: crypto.randomUUID(),
        requestKey: `${origin.value.originSessionId}:${input.requestKey}`,
      });
      if (!ask) return fail('Asks are not available on this daemon yet.');
      const same = (['concernId', 'title', 'ask', 'doneWhen', 'doneSource'] as const).every(
        (field) => ask[field] === input[field]
      );
      return same
        ? { ok: true as const, ask }
        : fail('This request key already belongs to another ask.');
    }
  );
  const settle = path(
    'neo.ask.settle',
    (input: z.infer<typeof Settle>) => service.askRecords.get(input.id)?.concernId,
    ({ id, outcome, evidence }, caller) => {
      const ask = service.askRecords.get(id);
      if (!ask) return fail('ask_not_found');
      if (caller.source === 'mcp' && caller.sessionId !== ask.originSessionId)
        return fail('Only the Neo session that opened this ask or the user can settle it.');
      if (ask.status === outcome && ask.outcome === evidence) return { ok: true as const, ask };
      if (isFinal(ask)) return fail(`ask_settled: this ask is already ${ask.status}.`);
      const settled = service.askRecords.settle(ask, outcome, evidence);
      return settled
        ? { ok: true as const, ask: settled }
        : fail('This ask changed; read it again.');
    }
  );
  return [
    defineOperation({
      name: 'neo.ask.open',
      description:
        'Record what the human asked for and what done means for it, from the current live input, before proposing its work. ask is the request in their words; doneWhen is the outcome that finishes it (for code, usually merged and not just a pull request opened); doneSource is "human" when the human said it, or the id of the standing rule it came from. Propose every card for this request with its askId. Reuse requestKey only to retry this input.',
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: open,
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'Settle an ask when its outcome is decided: achieved when every doneWhen item is met, with evidence; blocked when only the human can unblock it, saying what they need to decide; abandoned when it is no longer wanted. Achieved and abandoned are final. Proposing new work under a blocked ask reopens it. Only the Neo session that opened the ask or the user can settle it.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: settle,
    }),
  ];
}
