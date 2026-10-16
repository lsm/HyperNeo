import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isNeoAskSettled } from './done-check.ts';
import type {
  NeoAsk,
  NeoAskItem,
  NeoAskItemKind,
  NeoAskQuestionBecause,
} from '@hyperneo/shared/types/neo-snapshot';
import type { OperationCaller } from '../operations/registry.ts';
import { isPooledNeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoAskItemInput } from '../../storage/repositories/neo-ask-repository.ts';
import type {
  NeoAskNameable,
  Settle,
  NeoOutcomeCard,
  NeoAskQuestionItem,
  NeoAskSettlePlan,
  NeoAskSettleFacts,
  Edit,
  Answer,
} from './ask-inputs.ts';
import type { z } from 'zod';
import type { NeoDaemonTickPath } from './needs-you.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoAnswerItem } from './answer-outcome.ts';

export function neoPromptText(message: SDKMessage): string {
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

export const isFinal = isNeoAskSettled;

const ACTIVE_ASK_LIMIT = 50;

export const activeNeoAskItems = (ask: Pick<NeoAsk, 'doneItems'>) =>
  (ask.doneItems ?? []).filter((item) => !item.removed);

export const checklist = (ask: NeoAsk) =>
  activeNeoAskItems(ask).map((item) => ({ id: item.id, title: item.text }));

export function neoAsksOpenedBy(asks: readonly NeoAsk[], caller: OperationCaller): NeoAsk[] {
  return caller.source === 'mcp'
    ? asks.filter((ask) => ask.originSessionId === caller.sessionId)
    : [...asks];
}

export const NEO_RELEASED_CARD = new Set(['failed', 'cancelled']);

export function planNeoProposalBindings(
  input: { askId?: string; delivers?: readonly string[] },
  ask: NeoAsk | null,
  workId: string
): { itemId: string; deliveredBy: string }[] {
  return ask && input.askId
    ? (input.delivers ?? []).map((itemId) => ({ itemId, deliveredBy: workId }))
    : [];
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
    approvalSpent: null,
    ...(ask.workIds.some((id) => stalled.has(id))
      ? { stalledWorkIds: ask.workIds.filter((id) => stalled.has(id)) }
      : {}),
  }));
}

export function planNeoAskItems(input: {
  doneWhen?: string;
  doneItems?: readonly (Omit<NeoAskItemInput, 'check'> & { check?: string | null })[];
}): { doneWhen: string; items: NeoAskItemInput[] } {
  if (input.doneItems?.length)
    return {
      doneWhen: input.doneWhen ?? input.doneItems.map((item) => `- ${item.text}`).join('\n'),
      items: input.doneItems.map((item) => ({ ...item, check: item.check ?? null })),
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

export const neoAskSummary = (input: z.infer<typeof Settle>) => input.summary ?? input.evidence;

export const isNeoAskReplay = (ask: NeoAsk, input: z.infer<typeof Settle>) =>
  ask.status === input.outcome &&
  (ask.status === 'achieved' ||
    (ask.outcome === neoAskSummary(input) && (ask.evidence ?? ask.outcome) === input.evidence));

export const neoAskOpenDecisions = (ask: NeoAsk) =>
  (ask.doneItems ?? []).filter((item) => !item.removed && item.state === 'needs_you');

export function neoAskLatestQuestionBefore(
  asks: readonly Pick<NeoAsk, 'id' | 'doneItems'>[],
  at: number
): string | null {
  return (
    asks
      .flatMap((ask) =>
        neoAskOpenDecisions(ask as NeoAsk).flatMap((item) =>
          item.addedAt !== null && item.addedAt < at ? [{ id: ask.id, at: item.addedAt }] : []
        )
      )
      .sort((a, b) => b.at - a.at)[0]?.id ?? null
  );
}

export function isNeoHumanDrop(
  caller: OperationCaller,
  owns: boolean,
  about: boolean,
  asked: readonly Pick<NeoAskItem, 'addedAt'>[],
  prompt: { at: number } | null
): boolean {
  const turn = caller.neoTurn;
  return (
    caller.source === 'mcp' &&
    owns &&
    about &&
    !!turn?.human &&
    !turn.consultationId &&
    turn.isLive() &&
    !!prompt &&
    asked.every((item) => item.addedAt !== null && prompt.at > item.addedAt)
  );
}

export const NEO_DAEMON_TICKS: Record<NeoDaemonTickPath, string> = {
  check: 'the daemon ticks it itself from what it reads',
  watch:
    'the daemon ticks it itself once every watched pull request has merged and every watched issue has closed',
};

const NEO_AGENT_WORD =
  /\b(agent|session|worker)(['’]s)? (report|says|said|claims?|reports|reported)\b|\breported by\b|\baccording to the (agent|session|worker)\b|\bnot (independently )?(readable|verifiable|verified|checkable)\b|\b(can(no|')t|unable to) (verify|check|read)\b/i;

export const isNeoAgentWord = (evidence: string | undefined) =>
  !!evidence && NEO_AGENT_WORD.test(evidence);

export function neoItemDependentCards<T extends NeoOutcomeCard>(
  item: Pick<NeoAskItem, 'deliveredBy'>,
  cards: readonly T[]
): T[] {
  return item.deliveredBy ? cards.filter((card) => card.id === item.deliveredBy) : [];
}

const NEO_TERMINAL_CARD = new Set<NeoWork['status']>(['reported', 'failed', 'cancelled']);

export function neoAskLiveOutcomeCards(
  ask: Pick<NeoAsk, 'doneItems'>,
  cards: readonly NeoOutcomeCard[]
): string[] {
  return activeNeoAskItems(ask).flatMap((item) =>
    neoItemDependentCards(item, cards)
      .filter((card) => !NEO_TERMINAL_CARD.has(card.status))
      .map(
        (card) => `${item.id} is delivered by card ${card.id.slice(0, 8)}, which is ${card.status}`
      )
  );
}

export const NEO_HUMAN_TASK_REFUSALS = {
  approval:
    'approval_on_ask: expiry and stalled work are facts, not a new human decision. Ask a question only when the human must decide what happens next.',
  wait: 'not_the_human: a wait on a PR, merge, CI, deploy, card or anything else the daemon reads is not the human’s step. Keep the item pending; the daemon wakes you when cards report, and you tick it met once you read it.',
} as const;

const NEO_APPROVAL_REQUEST =
  /\b(re-?approv\w*|approv\w*\s+(?:\w+\s+){0,3}?again|renew\w*\s+(?:\w+\s+){0,2}?approval|approval\s+(?:has\s+|is\s+)?(?:expired|lapsed|spent|run out|ran out))\b|(?:重新|再次|再)批准/i;

export function neoAsksForApproval(...texts: (string | undefined)[]): boolean {
  return texts.some((text) => !!text && NEO_APPROVAL_REQUEST.test(text));
}

export function findNeoAskOpenQuestion(
  ask: NeoAsk,
  question: string,
  decides?: string
): NeoAskItem | null {
  const open = (ask.doneItems ?? []).filter((item) => !item.removed && item.state === 'needs_you');
  return (
    (decides ? open.find((item) => item.decides === decides) : undefined) ??
    open.find((item) => !item.decides && item.text === question) ??
    null
  );
}

export function planNeoAskRestate(
  asked: NeoAskItem | null,
  input: {
    question?: string;
    options?: readonly string[];
    kind?: NeoAskItemKind;
    decides?: string;
    because?: NeoAskQuestionBecause;
  }
): {
  id: string;
  text: string;
  question: string;
  kind: NeoAskItemKind;
  options: string[];
  decides: string;
  because: NeoAskQuestionBecause | null;
} | null {
  const decides = asked?.decides ?? input.decides;
  if (!asked || !decides || !input.question) return null;
  const kind = input.kind ?? asked.kind ?? 'decision';
  const because = input.because ?? asked.because ?? null;
  const same =
    asked.decides === decides &&
    JSON.stringify(asked.because ?? null) === JSON.stringify(because) &&
    asked.text === input.question &&
    asked.kind === kind &&
    JSON.stringify(asked.options ?? []) === JSON.stringify(input.options ?? []);
  return same
    ? null
    : {
        id: asked.id,
        text: input.question,
        question: input.question,
        kind,
        options: [...(input.options ?? [])],
        decides,
        because,
      };
}

export function planNeoAskQuestion(
  ask: NeoAsk,
  input: {
    question: string;
    options: readonly string[];
    kind?: NeoAskItemKind;
    decides?: string;
    because?: NeoAskQuestionBecause;
  }
): NeoAskQuestionItem {
  const [slot] = planNeoAskEdit(ask, {
    askId: ask.id,
    expectedRevision: ask.revision ?? 0,
    add: [{ text: input.question, check: null, outcomeKind: 'state' }],
    remove: [],
    track: [],
    bind: [],
  }).add;
  return {
    ...slot,
    kind: input.kind ?? 'decision',
    question: input.question,
    ...(input.decides ? { decides: input.decides } : {}),
    ...(input.because ? { because: input.because } : {}),
    options: [...(input.options ?? [])],
  };
}

export function planNeoAskSettle(
  input: z.infer<typeof Settle>,
  ask: NeoAsk,
  caller: OperationCaller
): NeoAskSettlePlan {
  const parked = input.outcome === 'waiting' || input.outcome === 'blocked';
  const waits = parked && caller.source === 'mcp' && !isNeoAskReplay(ask, input);
  const approval = waits && neoAsksForApproval(input.summary, input.question);
  const asked =
    parked && input.question ? findNeoAskOpenQuestion(ask, input.question, input.decides) : null;
  const item =
    waits && !approval && !asked && input.question && input.options
      ? planNeoAskQuestion(ask, {
          question: input.question,
          options: input.options,
          kind: input.kind,
          decides: input.decides,
          because: input.because,
        })
      : null;
  const open = (ask.doneItems ?? []).find((entry) => !entry.removed && entry.state === 'needs_you');
  return {
    waits,
    approval,
    item,
    restate: waits && !approval ? planNeoAskRestate(asked, input) : null,
    waitingItem: parked ? (item?.id ?? asked?.id ?? open?.id ?? null) : null,
  };
}

export function neoAskHasHumanAction(ask: NeoAsk, facts: NeoAskSettleFacts, _now: number): boolean {
  return (
    facts.offered ||
    facts.stalled ||
    facts.failed ||
    (ask.doneItems ?? []).some(
      (item) =>
        !item.removed &&
        (item.state === 'needs_you' || (item.state === 'reported' && !isNeoAnswerItem(item)))
    )
  );
}

export const heardText = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

const WORD_EDGE = /[\p{Script=Latin}\p{N}]/u;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function isNeoHumanQuote(words: string, text: string): boolean {
  if (CJK.test(words) ? [...words.replace(/\s/g, '')].length < 4 : words.split(' ').length < 2)
    return false;
  for (let at = text.indexOf(words); at >= 0; at = text.indexOf(words, at + 1)) {
    const before = text[at - 1] ?? ' ';
    const after = text[at + words.length] ?? ' ';
    const cut =
      (WORD_EDGE.test(before) && WORD_EDGE.test(words[0]!)) ||
      (WORD_EDGE.test(after) && WORD_EDGE.test(words.at(-1)!));
    if (!cut) return true;
  }
  return false;
}

const QUOTE_FILLER = new Set(
  'the a an and or but to of in on at it is be for with this that these those we you i me my our your its from by as not no do'.split(
    ' '
  )
);

function namingTerms(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = (lower.match(/[\p{Script=Latin}\p{N}]{2,}/gu) ?? []).filter(
    (word) => !QUOTE_FILLER.has(word)
  );
  const runs = lower.match(new RegExp(`${CJK.source}+`, 'gu')) ?? [];
  const pairs = runs.flatMap((run) => {
    const chars = [...run];
    return chars.slice(1).map((char, index) => `${chars[index]}${char}`);
  });
  return new Set([...words, ...pairs]);
}

export function isNeoQuoteNaming(words: string, item: Pick<NeoAskItem, 'text'>): boolean {
  const named = namingTerms(item.text);
  return [...namingTerms(words)].some((term) => named.has(term));
}

export function readNeoHumanQuote(
  input: Pick<z.infer<typeof Edit>, 'humanSaid'>,
  caller: OperationCaller,
  said: readonly string[]
): string | null {
  if (!input.humanSaid) return null;
  if (caller.source !== 'mcp') return input.humanSaid;
  const words = heardText(input.humanSaid);
  const turn = caller.neoTurn;
  return turn?.human &&
    !turn.consultationId &&
    turn.isLive() &&
    said.some((text) => isNeoHumanQuote(words, heardText(text)))
    ? input.humanSaid
    : null;
}

export function planNeoAskRemovedReason(
  input: Pick<z.infer<typeof Edit>, 'remove'>,
  caller: OperationCaller,
  quote: string | null
): string | null {
  if (!input.remove.length) return null;
  if (quote) return `The human said: "${quote}"`;
  return caller.source === 'mcp' ? null : 'Removed by the human.';
}

export function neoAnswerCitation(
  input: z.infer<typeof Answer>,
  caller: OperationCaller
): string | null {
  if (caller.source !== 'mcp') return null;
  return input.humanMessageId ?? caller.neoTurn?.messageId ?? null;
}

export function readNeoAskReply(input: z.infer<typeof Answer>): { choice: string; met: boolean } {
  return {
    choice: input.choice,
    met: true,
  };
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
      check: item.check ?? null,
      id: `i${next + index + 1}`,
      position: items.length + index,
    })),
    remove: [...new Set(input.remove)],
    track: input.track,
    bind: input.bind,
  };
}

export function planNeoAskTickStatus(
  ask: NeoAsk,
  settle: { cardLive: boolean; outcome?: string; changes: { metAt: number; removedAt: number } }
):
  | { status: 'achieved'; outcome: string; evidence: string }
  | { status: 'waiting'; outcome: string; item: string }
  | { status: 'open' }
  | { status: 'unchanged' } {
  if (isFinal(ask)) return { status: 'unchanged' };
  const items = activeNeoAskItems(ask);
  const held = ask.status === 'waiting' && !ask.waitingItem;
  if (
    settle.changes.metAt > settle.changes.removedAt &&
    !held &&
    !settle.cardLive &&
    items.length &&
    items.every((item) => item.state === 'met')
  ) {
    const evidence = [...new Set(items.map((item) => item.evidence ?? item.text))].join('; ');
    return { status: 'achieved', outcome: settle.outcome ?? evidence, evidence };
  }
  const asked =
    items.find((item) => item.state === 'needs_you') ??
    (items.some((item) => item.state === 'pending')
      ? undefined
      : items.find((item) => item.state === 'reported' && !isNeoAnswerItem(item)));
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
