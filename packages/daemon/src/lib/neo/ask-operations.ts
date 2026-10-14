import { NeoAskBindingError } from '../../storage/repositories/neo-ask-repository.ts';
import type { NeoProject, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  isPooledNeoAsk,
  type NeoAsk,
  type NeoAskItem,
  type NeoAskItemKind,
  neoAskApprovalSpent,
} from '@hyperneo/shared/types/neo-snapshot';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { GITHUB_REF_PATH } from '../github/parse-pr-url.ts';
import type {
  NeoAskInput,
  NeoAskItemInput,
  NeoAskRepository,
} from '../../storage/repositories/neo-ask-repository.ts';
import type { NeoService } from './service.ts';
import { isNeoAskSettled } from './done-check.ts';
import { requireNeoAskPack } from './packs/index.ts';
import type { buildNeoCheckRegistry } from './packs/check-registry.ts';
import { countNeoAskWatches, NEO_ASK_WATCH_MAX } from './packs/coding/watch-checks.ts';
import { admitNeoWorkOrigin, type NeoWorkOrigin } from './work-origin.ts';
import {
  neoDaemonReadsClaim,
  neoDaemonTickPath,
  neoHumanTickWakes,
  type NeoDaemonTickPath,
} from './needs-you.ts';
import { isNeoAskOutcomeItem } from './ask-views.ts';
import { NeoAskStateViewSchema } from './card-view-schema.ts';

type Rejection = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
type NeoAdmit = (
  caller: OperationCaller,
  name: string,
  projectId?: string | null
) => Gate<OperationCaller>;
type AskReceipt = { ok: true; ask: NeoAsk };
type AskOpened = AskReceipt & { packBriefing?: string };

const CheckKind = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A check kind registered by a loaded pack.');
const NEO_ASK_ITEM_KINDS = ['decision', 'action', 'approval', 'wait'] as const;
const Failure = z.object({ ok: z.literal(false), reason: z.string() });
export const NeoAskSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  approvedRevision: z.number().int().nonnegative().nullable().optional(),
  id: z.string(),
  requestKey: z.string(),
  projectId: z.string().nullable(),
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
  stalledWorkIds: z.array(z.string()).optional(),
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
        check: z.string().min(1).nullable(),
        verifiedDefinitionHash: z.string().nullable().optional(),
        deliveredBy: z.string().nullable().optional(),
        metBy: z.enum(['neo', 'daemon', 'human']).nullable(),
        removed: z.boolean(),
        addedAt: z.number().nullable(),
        options: z.array(z.string()).optional(),
        decision: z.literal(true).optional(),
        action: z.string().optional(),
        waitCard: z.string().optional(),
        kind: z.enum(NEO_ASK_ITEM_KINDS).optional(),
        question: z.string().optional(),
        watch: z.array(z.string()).optional(),
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
  z.object({
    ok: z.literal(true),
    ask: NeoAskSchema,
    view: NeoAskStateViewSchema.nullable().optional(),
    packBriefing: z.string().optional(),
  }),
]);
const WatchUrl = z
  .string()
  .trim()
  .regex(
    new RegExp(`^https://${GITHUB_REF_PATH.source}$`),
    'Pass a GitHub pull request or issue URL.'
  );
const DeliveredBy = z.string().trim().min(1).nullable().optional();
const Item = z.object({
  deliveredBy: DeliveredBy.describe(
    'Stable card ID delivering this outcome. On open only an unlinked card from the same owner/project can be claimed; on edit use a card already on this ask.'
  ),
  text: z.string().trim().min(1).max(300),
  check: CheckKind.nullable().default(null),
  watch: z.array(WatchUrl).min(1).max(10).optional(),
});
const Open = z
  .object({
    requestKey: z.string().min(1).max(160),
    projectId: z.string().min(1).nullable().default(null),
    title: z.string().trim().min(1).max(160),
    ask: z.string().trim().min(1).max(4000),
    doneWhen: z.string().trim().min(1).max(2000).optional(),
    doneItems: z.array(Item).min(1).optional(),
    doneSource: z.string().trim().min(1).max(160),
    pack: z.string().trim().min(1).max(80).optional(),
  })
  .refine((input) => input.doneWhen || input.doneItems, 'Pass doneItems, or doneWhen.')
  .refine(
    (input) => countNeoAskWatches(input.doneItems ?? []) <= NEO_ASK_WATCH_MAX,
    `An ask watches at most ${NEO_ASK_WATCH_MAX} pull requests and issues across its items.`
  );
type Opening = Omit<z.infer<typeof Open>, 'doneItems' | 'doneWhen'> & { doneWhen: string };
const Options = z
  .array(z.string().trim().min(1).max(80))
  .min(2)
  .max(4)
  .refine((options) => new Set(options).size === options.length, 'Options must differ.');
const Settle = z.preprocess(
  (input) =>
    input && typeof input === 'object' && !('id' in input) && 'askId' in input
      ? { ...input, id: (input as { askId: unknown }).askId }
      : input,
  z
    .object({
      id: z.string().min(1),
      outcome: z.enum(['achieved', 'abandoned', 'blocked', 'waiting']),
      summary: z.string().trim().min(1).max(200).optional(),
      evidence: z.string().trim().min(1).max(4000),
      kind: z.enum(NEO_ASK_ITEM_KINDS).optional(),
      question: z.string().trim().min(1).max(200).optional(),
      options: Options.optional(),
    })
    .refine(
      (input) => !input.question === !input.options,
      'Pass question and options together: one question and 2-4 short answers.'
    )
);

const ExpectedRevision = z
  .number()
  .int()
  .nonnegative()
  .default(0)
  .describe('The revision from the current ask view; refresh after stale_revision.');
const Tick = z.object({
  expectedRevision: ExpectedRevision,
  askId: z.string().min(1),
  itemId: z.string().min(1),
  state: z.enum(['pending', 'met', 'needs_you', 'reported']),
  evidence: z.string().trim().min(1).max(2000).optional(),
});

const Question = z.object({
  askId: z.string().min(1),
  question: z.string().trim().min(1).max(200),
  options: Options,
  kind: z.enum(NEO_ASK_ITEM_KINDS),
});

const Answer = z.object({
  expectedRevision: ExpectedRevision,
  askId: z.string().min(1),
  itemId: z.string().min(1),
  choice: z.string().trim().min(1).max(1000),
});

const Approve = z.object({ askId: z.string().min(1), expectedRevision: ExpectedRevision });
const Fold = z
  .object({ askId: z.string().min(1), intoAskId: z.string().min(1) })
  .refine((input) => input.askId !== input.intoAskId, 'Fold an ask into another ask.');
const Edit = z
  .object({
    expectedRevision: ExpectedRevision,
    askId: z.string().min(1),
    add: z.array(Item).default([]),
    remove: z.array(z.string().min(1)).default([]),
    bind: z
      .array(z.object({ itemId: z.string().min(1), deliveredBy: DeliveredBy.unwrap() }))
      .default([]),
    track: z
      .array(
        z
          .object({
            itemId: z.string().min(1),
            check: CheckKind.nullable().default(null),
            watch: z.array(WatchUrl).min(1).max(10).optional(),
          })
          .refine((item) => item.check || item.watch, 'Pass check or watch.')
      )
      .default([]),
  })
  .refine(
    (input) => input.add.length || input.remove.length || input.track.length || input.bind.length,
    'Pass items to add, remove, track or bind.'
  );

const fail = (reason: string): Rejection => ({ ok: false, reason });
const requireAskRevision = (input: { expectedRevision: number }, ask: NeoAsk): Gate<NeoAsk> =>
  input.expectedRevision === (ask.revision ?? 0)
    ? { value: ask }
    : { reason: fail('stale_revision: refresh the ask before changing or approving it.') };

function requireRegisteredChecks<T>(
  items: readonly { check?: string | null }[],
  registry: ReturnType<typeof buildNeoCheckRegistry>,
  value: T
): Gate<T> {
  if (!registry.ok) return { reason: registry };
  for (const item of items) {
    if (!item.check) continue;
    const check = registry.resolve(item.check);
    if (!check.ok) return { reason: check };
  }
  return { value };
}

function neoPromptText(message: SDKMessage): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .flatMap((block: { type?: string; text?: unknown }) =>
          block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
        )
        .join('\n')
    : '';
}
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

type WorkAskInput = { askId?: string; projectId: string | null };

export function requireNeoWorkAsk(
  ask: NeoAsk | null,
  input: WorkAskInput,
  caller: OperationCaller
): Gate<OperationCaller> {
  return input.askId && ask && ask.projectId !== input.projectId
    ? { reason: fail('This ask belongs to another project; propose under its projectId.') }
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
    projectId: string | null;
    title: string;
    goal?: string;
    doneWhen?: string;
  },
  origin: NeoWorkOrigin
): Omit<NeoAskInput, 'id'> | null {
  if (input.askId || !input.doneWhen) return null;
  return {
    requestKey: `card:${origin.originSessionId}:${input.requestKey}`,
    projectId: input.projectId,
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
  now: number,
  stalled: ReadonlySet<string> = new Set()
): NeoAsk[] {
  const active = asks.filter((ask) => !isFinal(ask)).slice(0, ACTIVE_ASK_LIMIT);
  return [...active, ...asks.filter(isFinal).slice(0, settledLimit)].map((ask) => ({
    ...ask,
    pooled: isPooledNeoAsk(ask),
    approvalSpent: neoAskApprovalSpent(ask, now),
    ...(ask.workIds.some((id) => stalled.has(id))
      ? { stalledWorkIds: ask.workIds.filter((id) => stalled.has(id)) }
      : {}),
  }));
}

export function requireNeoAskProject<T>(
  input: { projectId: string | null },
  found: { project: NeoProject | null },
  value: T
): Gate<T> {
  return input.projectId && !found.project ? { reason: fail('Project not found.') } : { value };
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

export function isNeoAskHandedOver(caller: OperationCaller): boolean {
  return caller.source === 'mcp' && !!caller.neoTurn?.human && caller.neoTurn.isLive();
}

export function requireNeoAskOriginFree(
  requestKey: string,
  origin: NeoWorkOrigin,
  existing: NeoAsk | null
): Gate<NeoWorkOrigin> {
  return existing && existing.requestKey !== `${origin.originSessionId}:${requestKey}`
    ? {
        reason: fail(
          `ask_exists_for_message: ask ${existing.id} ("${existing.title}") already records this message. Add to it with neo.ask.edit instead of opening another ask.`
        ),
      }
    : { value: origin };
}

export type NeoAskNameable = { id: string; title: string; cardIds: string[]; refs: string[] };

export function requireNeoAskHumanTurn(caller: OperationCaller): Gate<OperationCaller> {
  return caller.source !== 'mcp' ||
    (caller.neoTurn?.human && !caller.neoTurn.consultationId && caller.neoTurn.isLive())
    ? { value: caller }
    : {
        reason: fail(
          "Only a human message opens an ask, so add this as an item on the ask you're working on with neo.ask.edit."
        ),
      };
}

function githubRefForms(url: string): RegExp[] {
  const ref = /github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)/i.exec(url);
  if (!ref) return [];
  const [, owner, repo, kind, number] = ref;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`github\\.com/${escape(owner)}/${escape(repo)}/${kind}/${number}(?!\\d)`, 'i'),
    new RegExp(`(?<![\\w/#])#${number}(?!\\d)`),
    new RegExp(`${escape(owner)}/${escape(repo)}#${number}(?!\\d)`, 'i'),
  ];
}

const NEO_ASK_TITLE_MIN = 4;

export function neoAskTitleNamedIn(text: string, rawTitle: string): boolean {
  const title = rawTitle.trim();
  if ([...title].length < NEO_ASK_TITLE_MIN) return false;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^\w/.test(title) ? '(?<!\\w)' : '';
  const after = /\w$/.test(title) ? '(?!\\w)' : '';
  return new RegExp(`${before}${escaped}${after}`).test(text);
}

export function neoAskNamedBy(said: readonly string[], ask: NeoAskNameable): boolean {
  const text = said.join('\n');
  const ids = [ask.id, ...ask.cardIds].map((id) => id.toLowerCase());
  const named = (text.match(/(?<![0-9a-z])[0-9a-f]{8}[0-9a-f-]*/gi) ?? []).some((token) => {
    const prefix = token.toLowerCase().replace(/-+$/, '');
    return ids.some((id) => id.startsWith(prefix));
  });
  return (
    named ||
    neoAskTitleNamedIn(text, ask.title) ||
    ask.refs.some((url) => githubRefForms(url).some((form) => form.test(text)))
  );
}

export function requireNeoAskUnnamed(
  origin: NeoWorkOrigin,
  said: readonly string[],
  asks: readonly NeoAskNameable[]
): Gate<NeoWorkOrigin> {
  const named = asks.find((ask) => neoAskNamedBy(said, ask));
  return named
    ? {
        reason: fail(
          `This message is about ask ${named.id} (${named.title}); change it with neo.ask.edit instead of opening a new ask.`
        ),
      }
    : { value: origin };
}

export function requireNeoAskReceipt(
  input: Opening,
  opened: { ask: NeoAsk | null }
): Gate<AskReceipt> {
  const { ask } = opened;
  if (!ask) return { reason: fail('Asks are not available on this daemon yet.') };
  const same = (['projectId', 'title', 'ask', 'doneWhen', 'doneSource'] as const).every(
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
  const asked = open.filter((item) => item.state === 'needs_you');
  if (caller.source === 'mcp' && input.outcome === 'abandoned' && asked.length)
    return {
      reason: fail(
        `decision_open: ${asked.map((item) => `${item.id} "${item.text}"`).join('; ')} waits on the human. Settle waiting until they answer; only they can drop it.`
      ),
    };
  return input.outcome === 'achieved' && caller.source === 'mcp' && open.length
    ? {
        reason: fail(
          `checklist_incomplete: ${open.map((item) => `${item.id} "${item.text}" is ${item.state}`).join('; ')}. Tick each item met with neo.ask.tick first, or settle waiting or blocked.`
        ),
      }
    : { value: ask };
}

const NEO_TRACK_HOW =
  'Keep it pending; neo.ask.edit {askId, track: [{itemId, ...}]} tells the daemon what to read.';

const NEO_DAEMON_TICK_REFUSALS: Record<NeoDaemonTickPath, string> = {
  check:
    'daemon_ticks_check: the daemon ticks this item itself from what it reads (GitHub, and for coding.deployed the commit each daemon runs). Keep it pending; an agent’s word or your tick never makes it met.',
  watch:
    'daemon_ticks_watched: the daemon ticks this item itself once every watched pull request has merged and every watched issue has closed. Keep it pending.',
  needs_deploy_check: `daemon_reads_deploy: the daemon reads which commit each daemon runs, so a deploy is never met on a tick or an agent's report. Give the item check coding.deployed (and watch: [the pull request URLs] when they are not this ask's card PRs); the daemon ticks it once every daemon runs a commit containing them. ${NEO_TRACK_HOW}`,
  needs_watch: `daemon_reads_github: the daemon reads this pull request or issue itself. Give the item watch: [its URL]; the daemon ticks it once it merges or closes. ${NEO_TRACK_HOW}`,
};

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
  if (input.state === 'needs_you')
    return {
      reason: fail(
        'needs_you_removed: ask the human with neo.ask.question {askId, question, options, kind}. A decision is its own item, so never tick an outcome item needs_you; keep it pending.'
      ),
    };
  const path =
    caller.source === 'mcp' && input.state !== 'pending' ? neoDaemonTickPath(item) : null;
  if (path) return { reason: fail(NEO_DAEMON_TICK_REFUSALS[path]) };
  if (caller.source === 'mcp' && input.state === 'met' && isNeoAgentWord(input.evidence))
    return {
      reason: fail(
        "unverified: this evidence is only a working agent's word. Tick the item reported; it counts as met once you read it yourself or the human confirms it."
      ),
    };
  return input.state !== 'pending' && !input.evidence
    ? { reason: fail('evidence_required: say what shows the item is met or reported.') }
    : { value: { ask, item } };
}

const NEO_HUMAN_TASK_REFUSALS = {
  approval:
    "approval_on_ask: re-approving continued work is the ask's Approve, not a question. The daemon shows Approve itself when the approval expires or a card stalls; approving it wakes you.",
  wait: 'not_the_human: a wait on a PR, merge, CI, deploy, card or anything else the daemon reads is not the human’s step. Keep the item pending; the daemon wakes you when cards report, and you tick it met once you read it.',
  fact: 'daemon_readable: the daemon reads this itself (a PR, merge, CI, a deploy, a card, standing rules). For a pull request or issue, give the item watch: [url] with neo.ask.edit track and the daemon ticks it when they merge or close; otherwise keep it pending. reported is for claims you cannot read, such as a device.',
} as const;

export function requireNeoReportedReadable<T>(
  caller: OperationCaller,
  state: NeoAskItem['state'],
  claim: { text: string; context?: string },
  value: T
): Gate<T> {
  return caller.source === 'mcp' &&
    state === 'reported' &&
    neoDaemonReadsClaim(claim.text, claim.context)
    ? { reason: fail(NEO_HUMAN_TASK_REFUSALS.fact) }
    : { value };
}

export function requireNeoAskItemKind<T>(kind: NeoAskItemKind | undefined, value: T): Gate<T> {
  return kind === 'wait' || kind === 'approval'
    ? { reason: fail(NEO_HUMAN_TASK_REFUSALS[kind]) }
    : { value };
}

const NEO_APPROVAL_REQUEST =
  /\b(re-?approv\w*|approv\w*\s+(?:\w+\s+){0,3}?again|renew\w*\s+(?:\w+\s+){0,2}?approval|approval\s+(?:has\s+|is\s+)?(?:expired|lapsed|spent|run out|ran out))\b|(?:重新|再次|再)批准/i;

export function neoAsksForApproval(...texts: (string | undefined)[]): boolean {
  return texts.some((text) => !!text && NEO_APPROVAL_REQUEST.test(text));
}

export function requireNeoAskQuestionAsked<T>(question: string, value: T): Gate<T> {
  return neoAsksForApproval(question)
    ? { reason: fail(NEO_HUMAN_TASK_REFUSALS.approval) }
    : { value };
}

export function requireNeoAskApprovalLapsed<T>(
  ask: Pick<NeoAsk, 'approvedAt'>,
  stalled: boolean,
  now: number,
  value: T
): Gate<T> {
  return ask.approvedAt != null && !stalled && neoAskApprovalSpent(ask, now) === null
    ? {
        reason: fail(
          "approval_active: this ask's approval is active and none of its cards has stalled, so there is nothing for the human to approve again. Keep the work moving; the daemon shows Approve itself once the approval expires or a card stalls."
        ),
      }
    : { value };
}

export type NeoAskQuestionItem = NeoAskItemInput & {
  id: string;
  position: number;
  kind: NeoAskItemKind;
  question: string;
  options: string[];
};

export function findNeoAskOpenQuestion(ask: NeoAsk, question: string): NeoAskItem | null {
  return (
    (ask.doneItems ?? []).find(
      (item) => !item.removed && item.state === 'needs_you' && item.text === question
    ) ?? null
  );
}

export function planNeoAskQuestion(
  ask: NeoAsk,
  input: { question: string; options: readonly string[]; kind?: NeoAskItemKind }
): NeoAskQuestionItem {
  const [slot] = planNeoAskEdit(ask, {
    askId: ask.id,
    expectedRevision: ask.revision ?? 0,
    add: [{ text: input.question, check: null }],
    remove: [],
    track: [],
    bind: [],
  }).add;
  return {
    ...slot,
    kind: input.kind ?? 'decision',
    question: input.question,
    options: [...input.options],
  };
}

export function requireNeoAskQuestionRoom<T>(
  ask: NeoAsk,
  item: NeoAskQuestionItem | null,
  value: T
): Gate<T> {
  if (!item) return { value };
  const room = requireNeoAskEdit(
    {
      askId: ask.id,
      expectedRevision: ask.revision ?? 0,
      add: [{ text: item.text, check: null }],
      remove: [],
      track: [],
      bind: [],
    },
    ask
  );
  return 'reason' in room ? room : { value };
}

export type NeoAskSettleFacts = { offered: boolean; stalled: boolean; failed: boolean };
export type NeoAskSettlePlan = {
  waits: boolean;
  approval: boolean;
  item: NeoAskQuestionItem | null;
  waitingItem: string | null;
};

export function planNeoAskSettle(
  input: z.infer<typeof Settle>,
  ask: NeoAsk,
  caller: OperationCaller
): NeoAskSettlePlan {
  const parked = input.outcome === 'waiting' || input.outcome === 'blocked';
  const waits = parked && caller.source === 'mcp' && !isNeoAskReplay(ask, input);
  const approval = waits && neoAsksForApproval(input.summary, input.question);
  const asked = parked && input.question ? findNeoAskOpenQuestion(ask, input.question) : null;
  const item =
    waits && !approval && !asked && input.question && input.options
      ? planNeoAskQuestion(ask, {
          question: input.question,
          options: input.options,
          kind: input.kind,
        })
      : null;
  const open = (ask.doneItems ?? []).find((entry) => !entry.removed && entry.state === 'needs_you');
  return {
    waits,
    approval,
    item,
    waitingItem: parked ? (item?.id ?? asked?.id ?? open?.id ?? null) : null,
  };
}

export function neoAskHasHumanAction(ask: NeoAsk, facts: NeoAskSettleFacts, now: number): boolean {
  return (
    facts.offered ||
    facts.stalled ||
    facts.failed ||
    neoAskApprovalSpent(ask, now) !== null ||
    (ask.doneItems ?? []).some(
      (item) => !item.removed && (item.state === 'needs_you' || item.state === 'reported')
    )
  );
}

export function requireNeoAskSettleCarriesNoGate<T>(
  plan: NeoAskSettlePlan,
  ask: NeoAsk,
  facts: NeoAskSettleFacts,
  now: number,
  value: T
): Gate<T> {
  return plan.waits && !plan.item && !neoAskHasHumanAction(ask, facts, now)
    ? {
        reason: fail(
          'question_required: an ask waits only on something the human can act on. To ask them a decision, pass question and options (2-4 short answers) to this settle or call neo.ask.question; otherwise keep the work moving and leave the ask open.'
        ),
      }
    : { value };
}

export function requireNeoAskDecisionKept<T>(
  ask: NeoAsk,
  caller: OperationCaller,
  clears: readonly string[],
  value: T
): Gate<T> {
  if (caller.source !== 'mcp' || (caller.neoTurn?.human && caller.neoTurn.isLive()))
    return { value };
  const asked = (ask.doneItems ?? []).filter(
    (item) => !item.removed && item.state === 'needs_you' && clears.includes(item.id)
  );
  return asked.length
    ? {
        reason: fail(
          `decision_open: ${asked.map((item) => `${item.id} "${item.text}"`).join('; ')} waits on the human. Tick or remove it only in the turn where they answer it.`
        ),
      }
    : { value };
}

export function requireNeoAskQuestion(
  input: z.infer<typeof Answer>,
  ask: NeoAsk
): Gate<{ ask: NeoAsk; item: NeoAskItem }> {
  const item = ask.doneItems?.find((entry) => entry.id === input.itemId && !entry.removed);
  if (!item) return { reason: fail(`item_not_found: ${input.itemId} is not on this checklist.`) };
  if (item.state !== 'needs_you')
    return {
      reason: fail(`item_not_waiting: ${item.id} is ${item.state}, not waiting on an answer.`),
    };
  return isNeoAskOutcomeItem(item) && !item.options?.includes(input.choice)
    ? {
        reason: fail(
          `choice_not_offered: ${item.id} is a step the human did; answer ${item.options?.join(' or ')}.`
        ),
      }
    : { value: { ask, item } };
}

export function readNeoAskReply(
  input: z.infer<typeof Answer>,
  target: { item: NeoAskItem }
): { choice: string; met: boolean } {
  return {
    choice: input.choice,
    met: !isNeoAskOutcomeItem(target.item) || input.choice === target.item.options?.[0],
  };
}

export function requireNeoAskEdit(input: z.infer<typeof Edit>, ask: NeoAsk): Gate<NeoAsk> {
  const active = (ask.doneItems ?? []).filter((item) => !item.removed);
  const missing = input.remove.filter((id) => !active.some((item) => item.id === id));
  if (missing.length)
    return { reason: fail(`item_not_found: ${missing.join(', ')} is not on this checklist.`) };
  const left = active.length - new Set(input.remove).size + input.add.length;
  if (left < 1) return { reason: fail('checklist_empty: keep at least one item.') };
  const untracked = input.track.filter(
    (entry) =>
      !active.some(
        (item) =>
          item.id === entry.itemId && item.state !== 'met' && !input.remove.includes(item.id)
      )
  );
  if (untracked.length)
    return {
      reason: fail(
        `item_not_trackable: ${untracked.map((entry) => entry.itemId).join(', ')} is not an open item on this checklist.`
      ),
    };
  const kept = active
    .filter((item) => !input.remove.includes(item.id))
    .map((item) => ({
      ...item,
      watch: input.track.find((entry) => entry.itemId === item.id)?.watch ?? item.watch,
    }));
  return countNeoAskWatches([...kept, ...input.add]) > NEO_ASK_WATCH_MAX
    ? {
        reason: fail(
          `watch_full: an ask watches at most ${NEO_ASK_WATCH_MAX} pull requests and issues across its items.`
        ),
      }
    : { value: ask };
}

export function requireNeoAskFoldTarget(
  source: NeoAsk,
  target: NeoAsk | Rejection
): Gate<{ source: NeoAsk; target: NeoAsk }> {
  return 'ok' in target ? { reason: target } : { value: { source, target } };
}

export function planNeoAskFold(
  source: NeoAsk,
  target: NeoAsk
): { from: string; id: string; position: number }[] {
  const items = target.doneItems ?? [];
  const next = Math.max(0, ...items.map((item) => Number(item.id.slice(1)) || 0));
  return (source.doneItems ?? [])
    .filter((item) => !item.removed)
    .map((item, index) => ({
      from: item.id,
      id: `i${next + index + 1}`,
      position: items.length + index,
    }));
}

export function planNeoAskEdit(
  ask: NeoAsk,
  input: z.infer<typeof Edit>
): {
  add: (NeoAskItemInput & { id: string; position: number })[];
  remove: string[];
  track: z.infer<typeof Edit>['track'];
  bind: z.infer<typeof Edit>['bind'];
} {
  const items = ask.doneItems ?? [];
  const next = Math.max(0, ...items.map((item) => Number(item.id.slice(1)) || 0));
  return {
    add: input.add.map((item, index) => ({
      ...item,
      id: `i${next + index + 1}`,
      position: items.length + index,
    })),
    remove: [...new Set(input.remove)],
    track: input.track,
    bind: input.bind,
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

export function createNeoAskOperations(
  service: NeoService,
  admit: NeoAdmit,
  view: (ask: NeoAsk) => z.infer<typeof NeoAskStateViewSchema> | null
) {
  const withView = <T extends AskReceipt | Rejection>(result: T) =>
    result.ok
      ? service.db.getDatabase().transaction(() => {
          const ask = service.askRecords.get(result.ask.id) ?? result.ask;
          return { ...result, ask, view: view(ask) };
        })()
      : result;
  const withBindingView = async (run: () => AskReceipt | Rejection) => {
    try {
      return withView(run());
    } catch (error) {
      if (error instanceof NeoAskBindingError) return fail(error.message);
      throw error;
    }
  };
  const humanText = (sessionId: string, messageId: string) =>
    service.db
      .getSDKMessageRepo()
      .getStoredPromptsByUuid(sessionId, messageId)
      .filter((message) => 'inputKind' in message && message.inputKind === 'human')
      .map((message) => neoPromptText(message));
  const openNeoAsksOf = (origin: NeoWorkOrigin): NeoAskNameable[] =>
    service.askRecords
      .listLive()
      .filter(
        (ask) =>
          ask.originSessionId === origin.originSessionId &&
          ask.originMessageId !== origin.originMessageId
      )
      .map((ask) => ({
        id: ask.id,
        title: ask.title,
        cardIds: ask.workIds,
        refs: [
          ...ask.workIds.flatMap((id) => service.workPrs.get(id)?.prs.map((pr) => pr.url) ?? []),
          ...(ask.doneItems ?? []).flatMap((item) => (item.removed ? [] : (item.watch ?? []))),
        ],
      }));
  const readOwnedLiveAsk = (superpipe({})('neo-ask-owned-live') as PipelineAPI)
    .input(['askId', 'caller', 'name', 'verb'])
    .pipe((askId: string) => ({ ask: service.askRecords.get(askId) }), 'askId', 'current')
    .pipe(
      (caller: OperationCaller, current: { ask: NeoAsk | null }, name: string) =>
        admit(caller, name, current.ask?.projectId),
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
        admit(caller, 'neo.ask.open', input.projectId),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Open>) => ({
        project: input.projectId ? service.repo.getProject(input.projectId) : null,
      }),
      'input',
      'project'
    )
    .pipe(requireNeoAskProject, ['input', 'project', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Open>) => requireNeoAskPack(input.pack, service.packs()),
      'input',
      'result:admission'
    )
    .pipe(requireNeoAskHumanTurn, 'caller', 'result:admission')
    .pipe(
      (input: z.infer<typeof Open>, caller: OperationCaller) =>
        admitNeoWorkOrigin(
          caller,
          caller.sessionId ?? service.repo.getBindingForProject(input.projectId)?.sessionId
        ),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Open>, origin: NeoWorkOrigin) =>
        requireNeoAskOriginFree(
          input.requestKey,
          origin,
          origin.originMessageId
            ? service.askRecords.liveForOrigin(origin.originSessionId, origin.originMessageId)
            : null
        ),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (origin: NeoWorkOrigin, caller: OperationCaller) =>
        requireNeoAskUnnamed(
          origin,
          caller.source === 'mcp' && caller.sessionId && caller.neoTurn
            ? humanText(caller.sessionId, caller.neoTurn.messageId)
            : [],
          caller.source === 'mcp' ? openNeoAsksOf(origin) : []
        ),
      ['admission', 'caller'],
      'result:admission'
    )
    .pipe(planNeoAskItems, 'input', 'checklist')
    .pipe(
      (
        checklist: ReturnType<typeof planNeoAskItems>,
        origin: NeoWorkOrigin,
        input: z.infer<typeof Open>
      ) =>
        service.askRecords.forRequest(`${origin.originSessionId}:${input.requestKey}`)
          ? { value: origin }
          : requireRegisteredChecks(checklist.items, service.checkRegistry(), origin),
      ['checklist', 'admission', 'input'],
      'result:admission'
    )
    .pipe(
      (
        checklist: ReturnType<typeof planNeoAskItems>,
        origin: NeoWorkOrigin,
        input: z.infer<typeof Open>
      ) => {
        if (service.askRecords.forRequest(`${origin.originSessionId}:${input.requestKey}`))
          return { value: origin };
        const checked = service.outcomeCheckPolicy.requireChecks(checklist.items);
        return 'reason' in checked ? checked : { value: origin };
      },
      ['checklist', 'admission', 'input'],
      'result:admission'
    )
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
      (receipt: AskReceipt, caller: OperationCaller): AskReceipt =>
        isNeoAskHandedOver(caller) && receipt.ask.approvedAt == null
          ? {
              ...receipt,
              ask:
                service.askRecords.approve(receipt.ask.id, Date.now(), receipt.ask.revision ?? 0) ??
                receipt.ask,
            }
          : receipt,
      ['admission', 'caller'],
      'admission'
    )
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
        admit(caller, 'neo.ask.settle', current.ask?.projectId),
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
      (ask: NeoAsk): NeoAskSettleFacts => {
        const cards = ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []);
        return {
          offered: cards.some((card) => card.status === 'proposed'),
          stalled: cards.some((card) => service.isContinueStalled(card.id)),
          failed: cards.some((card) => card.status === 'failed'),
        };
      },
      'admission',
      'facts'
    )
    .pipe(planNeoAskSettle, ['input', 'admission', 'caller'], 'plan')
    .pipe(
      (input: z.infer<typeof Settle>, ask: NeoAsk, plan: NeoAskSettlePlan) =>
        requireNeoAskItemKind(plan.waits ? input.kind : undefined, ask),
      ['input', 'admission', 'plan'],
      'result:admission'
    )
    .pipe(
      (ask: NeoAsk, plan: NeoAskSettlePlan, facts: NeoAskSettleFacts) =>
        plan.approval
          ? requireNeoAskApprovalLapsed(ask, facts.stalled, Date.now(), ask)
          : { value: ask },
      ['admission', 'plan', 'facts'],
      'result:admission'
    )
    .pipe(
      (ask: NeoAsk, plan: NeoAskSettlePlan) => requireNeoAskQuestionRoom(ask, plan.item, ask),
      ['admission', 'plan'],
      'result:admission'
    )
    .pipe(
      (ask: NeoAsk, plan: NeoAskSettlePlan, facts: NeoAskSettleFacts) =>
        requireNeoAskSettleCarriesNoGate(plan, ask, facts, Date.now(), ask),
      ['admission', 'plan', 'facts'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Settle>, ask: NeoAsk, plan: NeoAskSettlePlan) => {
        if (isNeoAskReplay(ask, input)) return { ask };
        return {
          ask: service.askRecords.settle(
            ask,
            input.outcome,
            neoAskSummary(input),
            input.evidence,
            plan.waitingItem,
            plan.item
          ),
        };
      },
      ['input', 'admission', 'plan'],
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
    .pipe(requireAskRevision, ['input', 'admission'], 'result:admission')
    .pipe(requireNeoAskTick, ['input', 'admission', 'caller'], 'result:admission')
    .pipe(
      (target: { ask: NeoAsk; item: NeoAskItem }) =>
        requireRegisteredChecks([target.item], service.checkRegistry(), target),
      'admission',
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Tick>, caller: OperationCaller, target: { item: NeoAskItem }) =>
        neoHumanTickWakes(input.state, caller.source, target.item),
      ['input', 'caller', 'admission'],
      'wakes'
    )
    .pipe(
      (
        input: z.infer<typeof Tick>,
        target: { ask: NeoAsk; item: NeoAskItem },
        caller: OperationCaller
      ) =>
        requireNeoReportedReadable(
          caller,
          input.state,
          { text: target.item.text, context: input.evidence },
          target
        ),
      ['input', 'admission', 'caller'],
      'result:admission'
    )
    .pipe(
      (
        input: z.infer<typeof Tick>,
        target: { ask: NeoAsk; item: NeoAskItem },
        caller: OperationCaller
      ) => requireNeoAskDecisionKept(target.ask, caller, [input.itemId], target),
      ['input', 'admission', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Tick>, target: { ask: NeoAsk }, caller: OperationCaller) => {
        const written = service.askRecords.tickItem(
          target.ask.id,
          {
            id: input.itemId,
            state: input.state,
            evidence: input.evidence ?? null,
            metBy: input.state === 'met' ? (caller.source === 'mcp' ? 'neo' : 'human') : null,
          },
          Date.now(),
          target.ask.doneItems?.find((item) => item.id === input.itemId)
        );
        return { ask: written ? service.askRecords.get(target.ask.id) : null };
      },
      ['input', 'admission', 'caller'],
      'ticked'
    )
    .pipe(requireNeoAskWritten, 'ticked', 'result:admission')
    .pipe(replanAsk, 'admission', 'written')
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .pipe(
      async (input: z.infer<typeof Tick>, receipt: AskReceipt, wakes: boolean) => {
        const item = receipt.ask.doneItems?.find((entry) => entry.id === input.itemId);
        if (wakes && item) await service.deliverAskTicked(receipt.ask, item);
      },
      ['input', 'admission', 'wakes']
    )
    .endAsync('admission') as (
    input: z.infer<typeof Tick>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;
  const answer = (superpipe({})('neo.ask.answer') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Answer>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.answer', 'answer')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireAskRevision, ['input', 'admission'], 'result:admission')
    .pipe(requireNeoAskQuestion, ['input', 'admission'], 'result:admission')
    .pipe(readNeoAskReply, ['input', 'admission'], 'reply')
    .pipe(
      async (
        target: { ask: NeoAsk; item: NeoAskItem },
        reply: { choice: string; met: boolean }
      ) => {
        await service.deliverAskAnswer(target.ask, target.item, reply.choice, reply.met);
      },
      ['admission', 'reply']
    )
    .pipe(
      (
        input: z.infer<typeof Answer>,
        target: { ask: NeoAsk },
        reply: { choice: string; met: boolean }
      ) => {
        const written =
          !reply.met ||
          service.askRecords.tickItem(
            target.ask.id,
            {
              id: input.itemId,
              state: 'met',
              evidence: `The human answered: ${reply.choice}`,
              metBy: 'human',
            },
            Date.now(),
            target.ask.doneItems?.find((item) => item.id === input.itemId),
            true
          );
        return { ask: written ? service.askRecords.get(target.ask.id) : null };
      },
      ['input', 'admission', 'reply'],
      'answered'
    )
    .pipe(requireNeoAskWritten, 'answered', 'result:admission')
    .pipe(replanAsk, 'admission', 'written')
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .endAsync('admission') as (
    input: z.infer<typeof Answer>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;
  const question = (superpipe({})('neo.ask.question') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Question>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(
          readOwnedLiveAsk(input.askId, caller, 'neo.ask.question', 'ask a question on')
        ),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Question>, ask: NeoAsk) => requireNeoAskItemKind(input.kind, ask),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Question>, ask: NeoAsk) =>
        requireNeoAskQuestionAsked(input.question, ask),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Question>, ask: NeoAsk) =>
        findNeoAskOpenQuestion(ask, input.question) ? null : planNeoAskQuestion(ask, input),
      ['input', 'admission'],
      'item'
    )
    .pipe(
      (ask: NeoAsk, item: NeoAskQuestionItem | null) => requireNeoAskQuestionRoom(ask, item, ask),
      ['admission', 'item'],
      'result:admission'
    )
    .pipe(
      (ask: NeoAsk, item: NeoAskQuestionItem | null) => ({
        ask: item
          ? service.askRecords.settle(ask, 'waiting', item.text, item.text, item.id, item)
          : ask,
      }),
      ['admission', 'item'],
      'written'
    )
    .pipe(requireNeoAskWritten, 'written', 'result:admission')
    .end('admission') as (
    input: z.infer<typeof Question>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;
  const approve = (superpipe({})('neo.ask.approve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Approve>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.approve', 'approve')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireAskRevision, ['input', 'admission'], 'result:admission')
    .pipe(
      (ask: NeoAsk) => {
        const approved = service.askRecords.approve(ask.id, Date.now(), ask.revision ?? 0);
        if (approved) service.resetCardStalls(approved.workIds);
        return { ask: approved };
      },
      'admission',
      'approved'
    )
    .pipe(requireNeoAskWritten, 'approved', 'result:admission')
    .pipe(
      (receipt: AskReceipt) =>
        receipt.ask.workIds.filter(
          (id) =>
            service.repo.getWork(id)?.status === 'proposed' &&
            service.resolveWorkTarget(id).accepted
        ),
      'admission',
      'startable'
    )
    .pipe(async (startable: string[]) => {
      await Promise.allSettled(startable.map((id) => service.start(id)));
    }, 'startable')
    .endAsync('admission') as (
    input: z.infer<typeof Approve>,
    caller: OperationCaller
  ) => Promise<AskReceipt | Rejection>;
  const edit = (superpipe({})('neo.ask.edit') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Edit>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.edit', 'edit')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(requireAskRevision, ['input', 'admission'], 'result:admission')
    .pipe(requireNeoAskEdit, ['input', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Edit>, ask: NeoAsk) =>
        requireRegisteredChecks(
          [
            ...input.add,
            ...input.track.map((change) => ({
              check:
                change.check ?? ask.doneItems?.find((item) => item.id === change.itemId)?.check,
            })),
          ],
          service.checkRegistry(),
          ask
        ),
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Edit>, ask: NeoAsk) => {
        const tracked = new Map<string, NeoAskItem>();
        for (const change of input.track) {
          const item =
            tracked.get(change.itemId) ??
            ask.doneItems?.find((entry) => entry.id === change.itemId);
          if (item) tracked.set(item.id, { ...item, check: change.check ?? item.check });
        }
        const checked = service.outcomeCheckPolicy.requireChecks([
          ...input.add,
          ...tracked.values(),
        ]);
        return 'reason' in checked ? checked : { value: ask };
      },
      ['input', 'admission'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Edit>, ask: NeoAsk, caller: OperationCaller) =>
        requireNeoAskDecisionKept(ask, caller, input.remove, ask),
      ['input', 'admission', 'caller'],
      'result:admission'
    )
    .pipe(planNeoAskEdit, ['admission', 'input'], 'plan')
    .pipe(
      (ask: NeoAsk, plan: ReturnType<typeof planNeoAskEdit>) => {
        const written = service.askRecords.editItems(ask.id, plan, Date.now(), ask.revision ?? 0);
        return { ask: written ? service.askRecords.get(ask.id) : null };
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
  const fold = (superpipe({})('neo.ask.fold') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: z.infer<typeof Fold>, caller: OperationCaller) =>
        requireNeoOwnedLiveAsk(readOwnedLiveAsk(input.askId, caller, 'neo.ask.fold', 'fold')),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: z.infer<typeof Fold>, caller: OperationCaller) =>
        readOwnedLiveAsk(input.intoAskId, caller, 'neo.ask.fold', 'fold into'),
      ['input', 'caller'],
      'target'
    )
    .pipe(requireNeoAskFoldTarget, ['admission', 'target'], 'result:admission')
    .pipe(
      (pair: { source: NeoAsk; target: NeoAsk }) => ({
        folded: service.askRecords.fold(
          pair.source,
          pair.target,
          planNeoAskFold(pair.source, pair.target),
          `Superseded: folded into ask ${pair.target.id}.`,
          Date.now(),
          true
        ),
        ask: service.askRecords.get(pair.target.id),
      }),
      'admission',
      'written'
    )
    .pipe(
      (written: { folded: boolean; ask: NeoAsk | null }) =>
        requireNeoAskWritten({ ask: written.folded ? written.ask : null }),
      'written',
      'result:admission'
    )
    .pipe(replanAsk, 'admission', 'replanned')
    .pipe(requireNeoAskWritten, 'replanned', 'result:admission')
    .end('admission') as (
    input: z.infer<typeof Fold>,
    caller: OperationCaller
  ) => AskReceipt | Rejection;
  return [
    defineOperation({
      name: 'neo.ask.fold',
      description:
        "Fold one open ask into another when they are the same request, such as a duplicate opened by mistake: the folded ask's checklist items and cards move to intoAskId, and the folded ask closes as superseded. Both asks must be open and yours. Card IDs and valid outcome evidence survive the fold; the kept ask requires approval for its new revision.",
      inputSchema: Fold,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withBindingView(() => fold(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.open',
      description:
        'Record what the human asked for and what done means for it, from the current live input, before proposing its work. ask is the request in their words; doneItems is the checklist that finishes it, one checkable outcome per item; a plain doneWhen still works and its bullet lines become the items; new merge/deploy outcomes require the matching coding.pr_merged/coding.deployed check in doneItems; doneSource is "human" when the human said it, or the id of the standing rule it came from. pack optionally names the enabled domain pack this ask works under (coding for software work in git repositories); its guidance comes back as packBriefing, and neo.pack.read {id} returns it in full. An item that waits on GitHub pull requests or issues passes watch, their URLs: the daemon ticks it met itself when every watched pull request has merged (on the merge event) and every watched issue has closed, with the event or read states as evidence. A deploy item passes check coding.deployed (watch optionally names the pull requests; otherwise the ask’s card PRs): the daemon ticks it once every daemon, this one and each attached one, runs a commit containing their merge commits. Propose every work item for this request with its askId. An ask opened in a turn the human sent is approved at once, because they handed the work over: its work items start without a Start click, and the approval never covers deploying to production, deleting data or other destructive steps. Reuse requestKey only to retry this input.',
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withBindingView(() => open(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.tick',
      description:
        "Tick one item of an ask's done checklist (neo.snapshot returns ask.doneItems): met with the evidence that shows it, only for an item the daemon cannot read (never for a part the human dropped: remove that item with neo.ask.edit), reported when a working agent says it is done but nobody can read it (a physical change: an agent's word never makes an item met, and the ask cannot be achieved until the human confirms it), or back to pending. met and reported are refused for what the daemon reads: an item with watch or a GitHub or deploy check is ticked by the daemon, and an item naming a pull request, issue or deploy needs watch or check coding.deployed first (neo.ask.edit track). needs_you is refused: a decision or a check only the human can make is its own item, asked with neo.ask.question. reported is also refused for anything else the daemon reads itself (CI, a card, standing rules). Only the Neo session that opened the ask or the user can tick it.",
      inputSchema: Tick,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await tick(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.question',
      description:
        'Ask the human one question about this ask: the only way a decision, or a check only they can make, reaches them. question is one short question worded for this step; options are 2-4 short answers, which become their buttons. The question becomes its own checklist item and the ask waits on it; their answer ticks it met and is sent back to you, so act on it then. For a step only the human can check (on a device, or a machine the daemon cannot read), ask about its result with kind action and options written for that step in its own words, success first ("这一步成功了吗？" with "成功了" and "没成功"): the first option ticks it met, any other keeps it open and tells you. Never ask for re-approval: the daemon shows Approve itself when the approval expires or a card stalls. Asking the same open question again changes nothing. Only the Neo session that opened the ask or the user can ask on it.',
      inputSchema: Question,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await question(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.answer',
      description:
        "Answer a question on an ask (neo.ask.question): the human's choice (one of its options, or their own words) ticks the item met and is sent to the Neo session that opened the ask, which acts on it. A question about a step's result (kind action) is answered with one of its own options: the first ticks it met, any other keeps it open, and Neo hears the answer either way.",
      inputSchema: Answer,
      resultSchema: AskResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => withView(await answer(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.approve',
      description:
        "Approve an open ask: the daemon starts its proposed work items at once, and Neo starts the ones proposed under it later without a Start click on each (neo.work.start). Only the user approves: from the ask's Approve button, or Neo in the turn where the human said to go ahead with it. Its work items keep continuing while they make progress, for 48 hours; approving again after that renews the window. An approval never covers deploying to production, deleting data or other destructive steps.",
      inputSchema: Approve,
      resultSchema: AskResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => withView(await approve(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.edit',
      description:
        "Change an open ask's done checklist when what done means changes: bind [{itemId, deliveredBy}] links an outcome to a card on this ask (null removes it), invalidating its evidence and approval; material changes are refused after dispatch. add items (each can pass watch, GitHub pull request or issue URLs the daemon ticks it met on, and check, as in neo.ask.open), remove ones that no longer apply, or track open items: track [{itemId, watch, check}] sets what the daemon reads for an item already listed, so the daemon ticks it instead of you. New outcomes and changed tracking require the matching coding.pr_merged/coding.deployed check for PR merge or deploy outcomes; untouched legacy items stay unchanged. Removed items stay listed as removed, so the change is visible; never reword an item by removing and re-adding it silently, say why in your reply. Only the Neo session that opened the ask or the user can edit it.",
      inputSchema: Edit,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withBindingView(() => edit(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        'Settle an ask when its outcome is decided: achieved when every checklist item is ticked met with neo.ask.tick (refused otherwise; the user\'s close still overrides); waiting when the next step is the human\'s, never achieved or abandoned while a question waits on them; blocked when only the human can unblock it; abandoned when it is no longer wanted. waiting and blocked need something the human can act on: an open question, work offered for Start, a reported item, a failed or stalled card, or an expired approval. Otherwise pass question and options (2-4 short answers), which ask it as neo.ask.question does, with kind decision or action (approval and wait are refused); a settle never carries a free-text gate. Asking for renewed approval is refused while the approval is active and no card has stalled. summary is one short sentence the ask shows ("Merged in #6099.", "Start the composer redesign?"). evidence holds the proof (PR state, commits, checks), which the ask does not show. Achieved and abandoned are final and stop the ask\'s live work: queued work items close (done for achieved, cancelled for abandoned) and proposed work items are cancelled. Proposing, starting or continuing work under a waiting or blocked ask reopens it. Only the Neo session that opened the ask or the user can settle it; the user\'s close button calls this too.',
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await settle(input, caller)),
    }),
  ];
}
