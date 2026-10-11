import type { NeoConcern, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  isPooledNeoAsk,
  type NeoAsk,
  type NeoAskItem,
  neoAskApprovalSpent,
} from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type {
  NeoAskInput,
  NeoAskItemInput,
  NeoAskRepository,
} from '../../storage/repositories/neo-ask-repository.ts';
import type { NeoService } from './service.ts';
import { isNeoAskSettled } from './done-check.ts';
import { requireNeoAskPack } from './packs/index.ts';
import { CODING_CHECK_PR_MERGED } from './packs/coding/pack.ts';
import { LIFE_ADMIN_CHECK_CONFIRMED } from './packs/life-admin/pack.ts';
import { admitNeoWorkOrigin, type NeoWorkOrigin } from './work-origin.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type NeoAdmit = (
  caller: OperationCaller,
  name: string,
  concernId?: string | null
) => Gate<OperationCaller>;
type AskReceipt = { ok: true; ask: NeoAsk };
type AskOpened = AskReceipt & { packBriefing?: string };

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
  pack: z.string().nullable().optional(),
  approvedAt: z.number().nullable().optional(),
  approvedContinues: z.number().optional(),
  approvedUntil: z.number().optional(),
  approvedContinueLimit: z.number().optional(),
  pooled: z.boolean().optional(),
  approvalSpent: z.enum(['continues', 'expired']).nullable().optional(),
  waitingItem: z.string().nullable().optional(),
  status: z.enum(['open', 'waiting', 'achieved', 'abandoned', 'blocked']),
  outcome: z.string().nullable(),
  evidence: z.string().nullable().optional(),
  doneItems: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        state: z.enum(['pending', 'met', 'needs_you', 'reported']),
        evidence: z.string().nullable(),
        check: z.enum([CODING_CHECK_PR_MERGED, LIFE_ADMIN_CHECK_CONFIRMED]).nullable(),
        metBy: z.enum(['neo', 'daemon', 'human']).nullable(),
        removed: z.boolean(),
        addedAt: z.number().nullable(),
        options: z.array(z.string()).optional(),
      })
    )
    .optional(),
  workIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  settledAt: z.number().nullable(),
});
const AskResult = z.union([
  Failure,
  z.object({ ok: z.literal(true), ask: NeoAskSchema, packBriefing: z.string().optional() }),
]);
const Item = z.object({
  text: z.string().trim().min(1).max(300),
  check: z.enum([CODING_CHECK_PR_MERGED, LIFE_ADMIN_CHECK_CONFIRMED]).nullable().default(null),
});
const Open = z
  .object({
    requestKey: z.string().min(1).max(160),
    concernId: z.string().min(1).nullable().default(null),
    title: z.string().trim().min(1).max(160),
    ask: z.string().trim().min(1).max(4000),
    doneWhen: z.string().trim().min(1).max(2000).optional(),
    doneItems: z.array(Item).min(1).max(12).optional(),
    doneSource: z.string().trim().min(1).max(160),
    pack: z.string().trim().min(1).max(80).optional(),
  })
  .refine((input) => input.doneWhen || input.doneItems, 'Pass doneItems, or doneWhen.');
type Opening = Omit<z.infer<typeof Open>, 'doneItems' | 'doneWhen'> & { doneWhen: string };
const Settle = z.object({
  id: z.string().min(1),
  outcome: z.enum(['achieved', 'abandoned', 'blocked', 'waiting']),
  summary: z.string().trim().min(1).max(200).optional(),
  evidence: z.string().trim().min(1).max(4000),
});

const Tick = z.object({
  askId: z.string().min(1),
  itemId: z.string().min(1),
  state: z.enum(['pending', 'met', 'needs_you', 'reported']),
  evidence: z.string().trim().min(1).max(2000).optional(),
  options: z
    .array(z.string().trim().min(1).max(80))
    .min(2)
    .max(4)
    .refine((options) => new Set(options).size === options.length, 'Options must differ.')
    .optional(),
});

const Answer = z.object({
  askId: z.string().min(1),
  itemId: z.string().min(1),
  choice: z.string().trim().min(1).max(1000),
});

const Approve = z.object({ askId: z.string().min(1) });
const Edit = z
  .object({
    askId: z.string().min(1),
    add: z.array(Item).max(12).default([]),
    remove: z.array(z.string().min(1)).max(12).default([]),
  })
  .refine((input) => input.add.length || input.remove.length, 'Pass items to add or remove.');

const fail = (reason: string): Rejection => ({ ok: false, reason });
const isFinal = isNeoAskSettled;
const ACTIVE_ASK_LIMIT = 50;

export function requireNeoAskOwner(
  ask: NeoAsk | null,
  caller: OperationCaller,
  action: string,
  hint = ''
): Gate<NeoAsk> {
  if (!ask) return { reason: fail('ask_not_found') };
  return caller.source === 'mcp' && caller.sessionId !== ask.originSessionId
    ? {
        reason: fail(
          `Only the Neo session that opened this ask or the user can ${action} it${hint}.`
        ),
      }
    : { value: ask };
}

export function requireNeoAskLive(ask: NeoAsk, hint = ''): Gate<NeoAsk> {
  return isFinal(ask)
    ? { reason: fail(`ask_settled: this ask is already ${ask.status}${hint}.`) }
    : { value: ask };
}

type WorkAskInput = { askId?: string; concernId: string | null };

export function requireNeoWorkAsk(
  ask: NeoAsk | null,
  input: WorkAskInput,
  caller: OperationCaller
): Gate<OperationCaller> {
  return input.askId && ask && ask.concernId !== input.concernId
    ? { reason: fail('This ask belongs to another concern; propose under its concernId.') }
    : { value: caller };
}

export function requireNeoWorkAskOwner(
  ask: NeoAsk | null,
  input: WorkAskInput,
  caller: OperationCaller
): Gate<OperationCaller> {
  if (!input.askId) return { value: caller };
  const owned = requireNeoAskOwner(ask, caller, 'file work under', '; open your own ask');
  return 'reason' in owned ? owned : { value: caller };
}

export function requireNeoWorkAskLive(
  ask: NeoAsk | null,
  input: WorkAskInput,
  caller: OperationCaller
): Gate<OperationCaller> {
  if (!input.askId || !ask) return { value: caller };
  const live = requireNeoAskLive(ask, '; open a new ask');
  return 'reason' in live ? live : { value: caller };
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

export function projectNeoSnapshotAsks(
  asks: readonly NeoAsk[],
  settledLimit: number,
  now: number
): NeoAsk[] {
  const active = asks.filter((ask) => !isFinal(ask)).slice(0, ACTIVE_ASK_LIMIT);
  return [...active, ...asks.filter(isFinal).slice(0, settledLimit)].map((ask) => ({
    ...ask,
    pooled: isPooledNeoAsk(ask),
    approvalSpent: neoAskApprovalSpent(ask, now),
  }));
}

export function requireNeoAskConcern<T>(
  input: { concernId: string | null },
  found: { concern: NeoConcern | null },
  value: T
): Gate<T> {
  return input.concernId && !found.concern ? { reason: fail('Concern not found.') } : { value };
}

export function planNeoAskItems(input: {
  doneWhen?: string;
  doneItems?: readonly NeoAskItemInput[];
}): { doneWhen: string; items: NeoAskItemInput[] } {
  if (input.doneItems?.length)
    return {
      doneWhen: input.doneWhen ?? input.doneItems.map((item) => `- ${item.text}`).join('\n'),
      items: [...input.doneItems],
    };
  const doneWhen = input.doneWhen ?? '';
  const bullets = doneWhen
    .split('\n')
    .flatMap((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1]?.trim() || []);
  return {
    doneWhen,
    items: (bullets.length ? bullets : [doneWhen.trim()]).map((text) => ({ text, check: null })),
  };
}

export function requireNeoAskReceipt(
  input: Opening,
  opened: { ask: NeoAsk | null }
): Gate<AskReceipt> {
  const { ask } = opened;
  if (!ask) return { reason: fail('Asks are not available on this daemon yet.') };
  const same = (['concernId', 'title', 'ask', 'doneWhen', 'doneSource'] as const).every(
    (field) => ask[field] === input[field]
  );
  return same && (ask.pack ?? null) === (input.pack ?? null)
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
          'summary_required: pass summary, one short sentence the ask shows ("Merged in #6099."), and keep the proof in evidence.'
        ),
      }
    : { value: caller };
}

export function requireNeoAskSettleable(input: z.infer<typeof Settle>, ask: NeoAsk): Gate<NeoAsk> {
  return isNeoAskReplay(ask, input) ? { value: ask } : requireNeoAskLive(ask);
}

function requireNeoAskChecklistMet(
  input: z.infer<typeof Settle>,
  ask: NeoAsk,
  caller: OperationCaller
): Gate<NeoAsk> {
  const open = (ask.doneItems ?? []).filter((item) => !item.removed && item.state !== 'met');
  return input.outcome === 'achieved' && caller.source === 'mcp' && open.length
    ? {
        reason: fail(
          `checklist_incomplete: ${open.map((item) => `${item.id} "${item.text}" is ${item.state}`).join('; ')}. Tick each item met with neo.ask.tick first, or settle waiting or blocked.`
        ),
      }
    : { value: ask };
}

const NEO_AGENT_WORD =
  /\b(agent|session|worker)(['’]s)? (report|says|said|claims?|reports|reported)\b|\breported by\b|\baccording to the (agent|session|worker)\b|\bnot (independently )?(readable|verifiable|verified|checkable)\b|\b(can(no|')t|unable to) (verify|check|read)\b/i;

export const isNeoAgentWord = (evidence: string | undefined) =>
  !!evidence && NEO_AGENT_WORD.test(evidence);

function requireNeoAskTick(
  input: z.infer<typeof Tick>,
  ask: NeoAsk,
  caller: OperationCaller
): Gate<{ ask: NeoAsk; item: NeoAskItem }> {
  const item = ask.doneItems?.find((entry) => entry.id === input.itemId && !entry.removed);
  if (!item) return { reason: fail(`item_not_found: ${input.itemId} is not on this checklist.`) };
  if (caller.source === 'mcp' && input.state === 'met' && isNeoAgentWord(input.evidence))
    return {
      reason: fail(
        "unverified: this evidence is only a working agent's word. Tick the item reported; it counts as met once you read it yourself or the human confirms it."
      ),
    };
  if (input.options && input.state !== 'needs_you')
    return { reason: fail('options_need_decision: only a needs_you item carries options.') };
  return input.state !== 'pending' && !input.evidence
    ? {
        reason: fail(
          'evidence_required: say what shows the item is met, or what the human must decide.'
        ),
      }
    : { value: { ask, item } };
}

export function requireNeoAskQuestion(
  input: z.infer<typeof Answer>,
  ask: NeoAsk
): Gate<{ ask: NeoAsk; item: NeoAskItem }> {
  const item = ask.doneItems?.find((entry) => entry.id === input.itemId && !entry.removed);
  if (!item) return { reason: fail(`item_not_found: ${input.itemId} is not on this checklist.`) };
  return item.state === 'needs_you'
    ? { value: { ask, item } }
    : { reason: fail(`item_not_waiting: ${item.id} is ${item.state}, not waiting on an answer.`) };
}

export function requireNeoAskEdit(input: z.infer<typeof Edit>, ask: NeoAsk): Gate<NeoAsk> {
  const active = (ask.doneItems ?? []).filter((item) => !item.removed);
  const missing = input.remove.filter((id) => !active.some((item) => item.id === id));
  if (missing.length)
    return { reason: fail(`item_not_found: ${missing.join(', ')} is not on this checklist.`) };
  const left = active.length - new Set(input.remove).size + input.add.length;
  if (left < 1) return { reason: fail('checklist_empty: keep at least one item.') };
  return left > 12
    ? { reason: fail('checklist_full: an ask holds at most 12 items.') }
    : { value: ask };
}

export function planNeoAskEdit(
  ask: NeoAsk,
  input: z.infer<typeof Edit>
): { add: (NeoAskItemInput & { id: string; position: number })[]; remove: string[] } {
  const items = ask.doneItems ?? [];
  const next = Math.max(0, ...items.map((item) => Number(item.id.slice(1)) || 0));
  return {
    add: input.add.map((item, index) => ({
      ...item,
      id: `i${next + index + 1}`,
      position: items.length + index,
    })),
    remove: [...new Set(input.remove)],
  };
}

export function planNeoAskTickStatus(
  ask: NeoAsk
):
  | { status: 'waiting'; outcome: string; item: string }
  | { status: 'open' }
  | { status: 'unchanged' } {
  if (isFinal(ask)) return { status: 'unchanged' };
  const items = (ask.doneItems ?? []).filter((item) => !item.removed);
  const asked =
    items.find((item) => item.state === 'needs_you') ??
    (items.some((item) => item.state === 'pending')
      ? undefined
      : items.find((item) => item.state === 'reported'));
  if (asked)
    return ask.status === 'waiting' && ask.waitingItem === asked.id
      ? { status: 'unchanged' }
      : {
          status: 'waiting',
          outcome: asked.state === 'reported' ? `Confirm: ${asked.text}` : asked.text,
          item: asked.id,
        };
  return ask.status === 'waiting' && ask.waitingItem ? { status: 'open' } : { status: 'unchanged' };
}

export function writeNeoAskTickStatus(
  records: Pick<NeoAskRepository, 'settle' | 'reopen'>,
  ask: NeoAsk,
  plan: ReturnType<typeof planNeoAskTickStatus>
): NeoAsk | null {
  return plan.status === 'waiting'
    ? records.settle(ask, 'waiting', plan.outcome, plan.outcome, plan.item)
    : plan.status === 'open'
      ? records.reopen(ask)
      : ask;
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
  if (outcome === 'blocked' || outcome === 'waiting') return [];
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

export function requireNeoOwnedLiveAsk(read: NeoAsk | Rejection): Gate<NeoAsk> {
  return 'ok' in read ? { reason: read } : { value: read };
}

export function createNeoAskOperations(service: NeoService, admit: NeoAdmit) {
  const readOwnedLiveAsk = (superpipe({})('neo-ask-owned-live') as PipelineAPI)
    .input(['askId', 'caller', 'name', 'verb'])
    .pipe((askId: string) => ({ ask: service.askRecords.get(askId) }), 'askId', 'current')
    .pipe(
      (caller: OperationCaller, current: { ask: NeoAsk | null }, name: string) =>
        admit(caller, name, current.ask?.concernId),
      ['caller', 'current', 'name'],
      'result:ask'
    )
    .pipe(
      (current: { ask: NeoAsk | null }, caller: OperationCaller, verb: string) =>
        requireNeoAskOwner(current.ask, caller, verb),
      ['current', 'caller', 'verb'],
      'result:ask'
    )
    .pipe((ask: NeoAsk) => requireNeoAskLive(ask), 'ask', 'result:ask')
    .end('ask') as (
    askId: string,
    caller: OperationCaller,
    name: string,
    verb: string
  ) => NeoAsk | Rejection;
  const replanAsk = (receipt: AskReceipt) => ({
    ask: writeNeoAskTickStatus(service.askRecords, receipt.ask, planNeoAskTickStatus(receipt.ask)),
  });
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
      (input: z.infer<typeof Open>) => requireNeoAskPack(input.pack, service.packs()),
      'input',
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Open>, caller: OperationCaller) =>
        admitNeoWorkOrigin(
          caller,
          caller.sessionId ?? service.repo.getBindingForConcern(input.concernId)?.sessionId
        ),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(planNeoAskItems, 'input', 'checklist')
    .pipe(
      (input: z.infer<typeof Open>, checklist: ReturnType<typeof planNeoAskItems>): Opening => {
        const { doneItems: _items, ...rest } = input;
        return { ...rest, doneWhen: checklist.doneWhen };
      },
      ['input', 'checklist'],
      'opening'
    )
    .pipe(
      (opening: Opening, origin: NeoWorkOrigin, checklist: ReturnType<typeof planNeoAskItems>) => ({
        ask: service.askRecords.open(
          {
            ...opening,
            ...origin,
            id: crypto.randomUUID(),
            requestKey: `${origin.originSessionId}:${opening.requestKey}`,
          },
          checklist.items
        ),
      }),
      ['opening', 'admission', 'checklist'],
      'opened'
    )
    .pipe(requireNeoAskReceipt, ['opening', 'opened'], 'result:admission')
    .pipe(
      (receipt: AskReceipt): AskOpened => {
        const packBriefing = service.packBriefing(receipt.ask);
        return packBriefing ? { ...receipt, packBriefing } : receipt;
      },
      'admission',
      'admission'
    )
    .end('admission') as (
    input: z.infer<typeof Open>,
    caller: OperationCaller
  ) => AskOpened | Rejection;
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
    .pipe(
      (current: { ask: NeoAsk | null }, caller: OperationCaller) =>
        requireNeoAskOwner(current.ask, caller, 'settle'),
      ['current', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoAskSettleable, ['input', 'admission'], 'result:admission')
    .pipe(requireNeoAskChecklistMet, ['input', 'admission', 'caller'], 'result:admission')
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
  const tick = (superpipe({})('neo.ask.tick') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Tick>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.tick', 'tick')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoAskTick, ['input', 'admission', 'caller'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Tick>, target: { ask: NeoAsk }, caller: OperationCaller) => {
        service.askRecords.tickItem(
          target.ask.id,
          {
            id: input.itemId,
            state: input.state,
            evidence: input.evidence ?? null,
            metBy: input.state === 'met' ? (caller.source === 'mcp' ? 'neo' : 'human') : null,
            options: input.options,
          },
          Date.now()
        );
        return { ask: service.askRecords.get(target.ask.id) };
      },
      ['input', 'admission', 'caller'],
      'ticked'
    )
    .pipe(requireNeoAskWritten, 'ticked', 'result:admission')
    .pipe(replanAsk, 'admission', 'written')
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .end('admission') as (
    input: z.infer<typeof Tick>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;
  const answer = (superpipe({})('neo.ask.answer') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Answer>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.answer', 'answer')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoAskQuestion, ['input', 'admission'], 'result:admission')
    .pipe(
      async (input: z.infer<typeof Answer>, target: { ask: NeoAsk; item: NeoAskItem }) => {
        await service.deliverAskAnswer(target.ask, target.item, input.choice);
      },
      ['input', 'admission']
    )
    .pipe(
      (input: z.infer<typeof Answer>, target: { ask: NeoAsk }) => {
        service.askRecords.tickItem(
          target.ask.id,
          {
            id: input.itemId,
            state: 'met',
            evidence: `The human answered: ${input.choice}`,
            metBy: 'human',
          },
          Date.now()
        );
        return { ask: service.askRecords.get(target.ask.id) };
      },
      ['input', 'admission'],
      'answered'
    )
    .pipe(requireNeoAskWritten, 'answered', 'result:admission')
    .pipe(replanAsk, 'admission', 'written')
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .endAsync('admission') as (
    input: z.infer<typeof Answer>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;
  const approve = (superpipe({})('neo.ask.approve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Approve>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.approve', 'approve')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (ask: NeoAsk) => ({ ask: service.askRecords.approve(ask.id, Date.now()) }),
      'admission',
      'approved'
    )
    .pipe(requireNeoAskWritten, 'approved', 'result:admission')
    .end('admission') as (
    input: z.infer<typeof Approve>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;
  const edit = (superpipe({})('neo.ask.edit') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Edit>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.edit', 'edit')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoAskEdit, ['input', 'admission'], 'result:admission')
    .pipe(planNeoAskEdit, ['admission', 'input'], 'plan')
    .pipe(
      (ask: NeoAsk, plan: ReturnType<typeof planNeoAskEdit>) => {
        service.askRecords.editItems(ask.id, plan, Date.now());
        return { ask: service.askRecords.get(ask.id) };
      },
      ['admission', 'plan'],
      'edited'
    )
    .pipe(requireNeoAskWritten, 'edited', 'result:admission')
    .pipe(replanAsk, 'admission', 'written')
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .end('admission') as (
    input: z.infer<typeof Edit>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;
  return [
    defineOperation({
      name: 'neo.ask.open',
      description:
        'Record what the human asked for and what done means for it, from the current live input, before proposing its work. ask is the request in their words; doneItems is the checklist that finishes it, one checkable outcome per item; a plain doneWhen still works and its bullet lines become the items; doneSource is "human" when the human said it, or the id of the standing rule it came from. pack optionally names the enabled domain pack this ask works under (coding for software work in git repositories); its guidance comes back as packBriefing, and neo.pack.read {id} returns it in full. Propose every work item for this request with its askId. Reuse requestKey only to retry this input.',
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => open(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.tick',
      description:
        "Tick one item of an ask's done checklist (neo.snapshot returns ask.doneItems): met with the evidence that shows it, read by you or the daemon (never for a part the human dropped: remove that item with neo.ask.edit), reported when a working agent says it is done but you cannot read it yourself (another machine, a deploy, a physical change: an agent's word never makes an item met, and the ask cannot be achieved until the human confirms it), needs_you with what the human must decide (pass options, 2-4 short choices, when the answer is one of a few; the human taps one and neo.ask.answer sends it back to you), or back to pending. A needs_you item puts the ask waiting with that item as its question until no item needs the human. Only the Neo session that opened the ask or the user can tick it.",
      inputSchema: Tick,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => tick(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.answer',
      description:
        "Answer a needs_you item of an ask: the human's choice (one of its options, or their own words) ticks the item met and is sent to the Neo session that opened the ask, which acts on it.",
      inputSchema: Answer,
      resultSchema: AskResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => answer(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.approve',
      description:
        "Approve an open ask so Neo starts the work items under it without a Start click on each (neo.work.start). Only the user approves: from the ask's Approve button, or Neo in the turn where the human said to go ahead with it. Their continues come from the ask's shared budget; approving again refills it. An approval never covers deploying to production, deleting data or other destructive steps.",
      inputSchema: Approve,
      resultSchema: AskResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => approve(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.edit',
      description:
        "Change an open ask's done checklist when what done means changes: add items, or remove ones that no longer apply. Removed items stay listed as removed, so the change is visible; never reword an item by removing and re-adding it silently, say why in your reply. Only the Neo session that opened the ask or the user can edit it.",
      inputSchema: Edit,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => edit(input, caller),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'Settle an ask when its outcome is decided: achieved when every checklist item is ticked met with neo.ask.tick (refused otherwise; the user\'s close still overrides); waiting when the next step is the human\'s (an offer to start work, or a delivered result that leaves them decisions), never achieved while decisions are pending; blocked when only the human can unblock it; abandoned when it is no longer wanted. summary is one short sentence the ask shows: the outcome, or for waiting and blocked what the human must decide ("Merged in #6099.", "Start the composer redesign?", "Needs you: pick the release date."). evidence holds the proof (PR state, commits, checks), which the ask does not show. Achieved and abandoned are final and stop the ask\'s live work: queued work items close (done for achieved, cancelled for abandoned) and proposed work items are cancelled. Proposing, starting or continuing work under a waiting or blocked ask reopens it. Only the Neo session that opened the ask or the user can settle it; the user\'s close button calls this too.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => settle(input, caller),
    }),
  ];
}
