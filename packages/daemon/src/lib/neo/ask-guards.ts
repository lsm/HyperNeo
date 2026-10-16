import type {
  Rejection,
  Gate,
  WorkAskInput,
  NeoAskNameable,
  Opening,
  AskReceipt,
  Settle,
  Tick,
  NeoDaemonTicked,
  NeoOutcomeCard,
  NeoAskQuestionItem,
  NeoAskSettlePlan,
  NeoAskSettleFacts,
  Edit,
  Answer,
} from './ask-inputs.ts';
import type {
  NeoAsk,
  NeoAskItem,
  NeoAskItemKind,
  NeoAskQuestionBecause,
} from '@hyperneo/shared/types/neo-snapshot';
import type { buildNeoCheckRegistry } from './packs/check-registry.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { neoKnownIds } from './known-ids.ts';
import {
  isFinal,
  NEO_RELEASED_CARD,
  neoAskNamedBy,
  isNeoAskReplay,
  neoAskOpenDecisions,
  NEO_DAEMON_TICKS,
  checklist,
  isNeoAgentWord,
  neoItemDependentCards,
  neoAskLiveOutcomeCards,
  NEO_HUMAN_TASK_REFUSALS,
  neoAsksForApproval,
  neoAskHasHumanAction,
  isNeoQuoteNaming,
  heardText,
  activeNeoAskItems,
} from './ask-plans.ts';
import type { NeoWork, NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoOutcomeBindingPolicy } from './outcome-binding-policy.ts';
import type { NeoWorkOrigin } from './work-origin.ts';
import type { z } from 'zod';
import { isNeoAnswerItem } from './answer-outcome.ts';
import { neoDaemonTickPath } from './needs-you.ts';
import { countNeoAskWatches, NEO_ASK_WATCH_MAX } from './packs/coding/watch-checks.ts';

export const fail = (reason: string): Rejection => ({ ok: false, reason });

export const requireAskRevision = (
  input: { expectedRevision: number },
  ask: NeoAsk
): Gate<NeoAsk> =>
  input.expectedRevision === (ask.revision ?? 0)
    ? { value: ask }
    : { reason: fail('stale_revision: refresh the ask before changing or approving it.') };

export function requireNeoAnswerItemsUnchecked<T>(
  items: readonly (Pick<NeoAskItem, 'text' | 'watch' | 'outcomeKind'> & {
    check?: string | null;
  })[],
  value: T
): Gate<T> {
  const checked = items.find(
    (item) => item.outcomeKind === 'answer' && (item.check || item.watch?.length)
  );
  return checked
    ? {
        reason: fail(
          `answer_checked: "${checked.text}" is an answer outcome, met when you publish the answer to the human, so it carries no check or watch. Make it outcomeKind "state" if the daemon should read it.`
        ),
      }
    : { value };
}

export function requireRegisteredChecks<T>(
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

export function requireNeoAskOwner(
  ask: NeoAsk | null,
  caller: OperationCaller,
  action: string,
  hint = '',
  known: readonly Pick<NeoAsk, 'id' | 'title'>[] = []
): Gate<NeoAsk> {
  if (!ask)
    return {
      reason: fail(
        `ask_not_found: no ask has that id. ${neoKnownIds('live asks you opened', known)}`
      ),
    };
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
  caller: OperationCaller,
  known: readonly NeoAsk[] = []
): Gate<OperationCaller> {
  if (!input.askId) return { value: caller };
  const owned = requireNeoAskOwner(ask, caller, 'file work under', '; open your own ask', known);
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

export function requireNeoProposalDelivers<T>(
  delivers: readonly string[] | undefined,
  ask: NeoAsk | null,
  read: { stored: string | null; cards: readonly Pick<NeoWork, 'id' | 'status'>[] },
  value: T
): Gate<T> {
  if (!ask || (read.stored && delivers === undefined)) return { value };
  const open = (ask.doneItems ?? []).filter(
    (item) => neoOutcomeBindingPolicy.isBindable(item) && item.state !== 'met'
  );
  if (delivers === undefined)
    return open.length
      ? {
          reason: fail(
            `delivers_required: this ask has open items ${open.map((item) => `${item.id} "${item.text}"`).join('; ')}. Pass delivers with the ids of the items this card delivers, or delivers: [] when it delivers none.`
          ),
        }
      : { value };
  const repeated = delivers.find((id, index) => delivers.indexOf(id) !== index);
  if (repeated !== undefined)
    return { reason: fail(`delivers_repeated: ${repeated} is listed twice; name each item once.`) };
  for (const id of delivers) {
    const item = open.find((entry) => entry.id === id);
    if (!item)
      return {
        reason: fail(
          (ask.doneItems ?? []).some(
            (entry) => entry.id === id && entry.check === 'coding.pr_opened'
          )
            ? `delivers_unknown: ${id} is a PR-opened check, met when the PR opens; no card delivers it, so leave it out of delivers.`
            : `delivers_unknown: ${id} is not an open item a card can deliver. ${neoKnownIds(
                'open items',
                open.map((entry) => ({ id: entry.id, title: entry.text }))
              )}`
        ),
      };
    const holder = read.cards.find(
      (card) => card.id === item.deliveredBy && card.id !== read.stored
    );
    if (holder && !NEO_RELEASED_CARD.has(holder.status))
      return {
        reason: fail(
          `delivers_taken: ${id} is delivered by card ${holder.id.slice(0, 8)}, which is ${holder.status}; only a failed or cancelled card releases its items.`
        ),
      };
  }
  return { value };
}

export function requireNeoAskProject<T>(
  input: { projectId: string | null },
  found: { project: NeoProject | null },
  value: T
): Gate<T> {
  return input.projectId && !found.project ? { reason: fail('Project not found.') } : { value };
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

export function requireNeoAskHumanTurn(
  caller: OperationCaller,
  owns: boolean
): Gate<OperationCaller> {
  return caller.source !== 'mcp' || (owns && caller.neoTurn?.isLive())
    ? { value: caller }
    : {
        reason: fail(
          "Only a human message opens an ask, so add this as an item on the ask you're working on with neo.ask.edit."
        ),
      };
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

export function requireNeoAskChecklistMet(
  input: z.infer<typeof Settle>,
  ask: NeoAsk,
  caller: OperationCaller,
  drop: { text: string } | null
): Gate<NeoAsk> {
  const open = (ask.doneItems ?? []).filter((item) => !item.removed && item.state !== 'met');
  const asked = neoAskOpenDecisions(ask);
  if (caller.source === 'mcp' && input.outcome === 'abandoned' && asked.length && !drop)
    return {
      reason: fail(
        `decision_open: ${asked.map((item) => `${item.id} "${item.text}"`).join('; ')} waits on the human. Settle waiting until they answer, or settle abandoned in the turn the human's own message drops the ask.`
      ),
    };
  if (input.outcome !== 'achieved' || caller.source !== 'mcp' || !open.length)
    return { value: ask };
  const daemon = (item: NeoAskItem) => (isNeoAnswerItem(item) ? null : neoDaemonTickPath(item));
  const fact = (item: NeoAskItem) => {
    const path = daemon(item);
    if (isNeoAnswerItem(item)) return ', and is met when its answer reaches the human';
    if (!path) return '';
    return item.state === 'reported'
      ? ', and waits on the human to confirm it'
      : `, and ${NEO_DAEMON_TICKS[path]}`;
  };
  const ids = (items: NeoAskItem[]) => items.map((item) => item.id).join(', ');
  const tickable = open.filter((item) => !daemon(item) && !isNeoAnswerItem(item));
  const answers = open.filter((item) => isNeoAnswerItem(item) && item.state !== 'reported');
  const steps = [
    ...(tickable.length ? [`tick ${ids(tickable)} met with neo.ask.tick`] : []),
    ...(answers.length ? [`tick ${ids(answers)} reported with the result`] : []),
  ];
  return {
    reason: fail(
      `checklist_incomplete: ${open.map((item) => `${item.id} "${item.text}" is ${item.state}${fact(item)}`).join('; ')}. ${
        steps.length
          ? `First ${steps.join(' and ')}, or settle waiting or blocked.`
          : 'None of these is Neo’s to tick; settle waiting or blocked until they are met.'
      }`
    ),
  };
}

export function requireNeoAskTick(
  input: z.infer<typeof Tick>,
  ask: NeoAsk,
  caller: OperationCaller
): { value: { ask: NeoAsk; item: NeoAskItem } } | { reason: Rejection | NeoDaemonTicked } {
  const item = ask.doneItems?.find((entry) => entry.id === input.itemId && !entry.removed);
  if (!item)
    return {
      reason: fail(
        `item_not_found: ${input.itemId} is not on this checklist. ${neoKnownIds('items on it', checklist(ask))}`
      ),
    };
  if (input.state === 'needs_you')
    return {
      reason: fail(
        'needs_you_removed: ask the human with neo.ask.question {askId, question, decides, options, kind}. A decision is its own item, so never tick an outcome item needs_you; keep it pending.'
      ),
    };
  if (caller.source === 'mcp' && input.state === 'met' && isNeoAnswerItem(item))
    return {
      reason: fail(
        'answer_unpublished: an answer item is met when the answer reaches the human. Tick it reported with the result; the daemon then wakes you to publish the answer and ticks it met when you do.'
      ),
    };
  const path =
    caller.source === 'mcp' && input.state !== 'pending' && !isNeoAnswerItem(item)
      ? neoDaemonTickPath(item)
      : null;
  if (path)
    return {
      reason: {
        ok: true,
        ask,
        note: `${item.id} is ${item.state}: ${NEO_DAEMON_TICKS[path]}, so this tick changed nothing.`,
      },
    };
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

export function requireNeoMetReadEvidence<T>(
  caller: OperationCaller,
  state: NeoAskItem['state'],
  item: Pick<NeoAskItem, 'id' | 'deliveredBy'>,
  cards: readonly NeoOutcomeCard[],
  value: T
): Gate<T> {
  if (caller.source !== 'mcp' || state !== 'met') return { value };
  const unread = neoItemDependentCards(item, cards).filter((card) => card.status !== 'reported');
  return unread.length
    ? {
        reason: fail(
          `met_unread: ${item.id} is delivered by ${unread.map((card) => `card ${card.id.slice(0, 8)}, which is ${card.status}`).join(' and ')}, so the daemon has not read its result. Keep the item pending: a proposed or queued card wakes you when it reports, and a failed or cancelled one needs new work.`
        ),
      }
    : { value };
}

export function requireNeoSettleKeepsOutcomeCards<T>(
  caller: OperationCaller,
  outcome: z.infer<typeof Settle>['outcome'],
  ask: Pick<NeoAsk, 'doneItems'>,
  cards: readonly NeoOutcomeCard[],
  value: T
): Gate<T> {
  if (caller.source !== 'mcp' || outcome !== 'achieved') return { value };
  const live = neoAskLiveOutcomeCards(ask, cards);
  return live.length
    ? {
        reason: fail(
          `outcome_card_live: ${live.join('; ')}. Settling achieved would close a card the outcome still depends on; wait for it to report, or settle waiting.`
        ),
      }
    : { value };
}

export function requireNeoAskItemKind<T>(kind: NeoAskItemKind | undefined, value: T): Gate<T> {
  return kind === 'wait' || kind === 'approval'
    ? { reason: fail(NEO_HUMAN_TASK_REFUSALS[kind]) }
    : { value };
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
  return ask.approvedAt != null && !stalled
    ? {
        reason: fail(
          'approval_active: this ask already has approval. Authorization follows the approved plan revision.'
        ),
      }
    : { value };
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
      add: [{ text: item.text, check: null, outcomeKind: 'state' }],
      remove: [],
      track: [],
      bind: [],
    },
    ask
  );
  return 'reason' in room ? room : { value };
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
          'question_required: an ask waits only on something the human can act on. To ask them a decision, pass question, decides (the decision it asks) and options (2-4 short answers) to this settle or call neo.ask.question; otherwise keep the work moving and leave the ask open.'
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

export function requireNeoAskScopeCut(
  input: Pick<z.infer<typeof Edit>, 'remove'>,
  ask: NeoAsk,
  caller: OperationCaller,
  quote: string | null
): Gate<NeoAsk> {
  if (caller.source !== 'mcp') return { value: ask };
  const unfinished = (ask.doneItems ?? []).filter(
    (item) =>
      input.remove.includes(item.id) &&
      !item.removed &&
      item.state !== 'met' &&
      !item.decision &&
      !item.kind &&
      !item.options
  );
  if (!unfinished.length) return { value: ask };
  return quote && unfinished.every((item) => isNeoQuoteNaming(heardText(quote), item))
    ? { value: ask }
    : {
        reason: fail(
          `scope_kept: ${unfinished.map((item) => `${item.id} "${item.text}"`).join('; ')} is not done, and only the human drops unfinished work. Remove it only in the turn where they tell you to drop it, passing humanSaid with their words from that message that name it (at least two whole words, or four characters of Chinese or Japanese, sharing a word with the item); when they only point at it, ask them with neo.ask.question or let them remove it in the app; otherwise keep it pending and keep working on it, or settle waiting with a question if you need them to decide.`
        ),
      };
}

export function requireNeoAskBecauseCard<T>(
  because: NeoAskQuestionBecause | undefined,
  ask: Pick<NeoAsk, 'workIds'>,
  value: T
): Gate<T> {
  return because && !ask.workIds.includes(because.card)
    ? {
        reason: fail(
          `because_card_unknown: ${because.card} is not a card under this ask; name one of its cards or leave because out.`
        ),
      }
    : { value };
}

export function requireNeoAskQuestion(
  input: z.infer<typeof Answer>,
  ask: NeoAsk
): Gate<{ ask: NeoAsk; item: NeoAskItem }> {
  const withdrawn = ask.doneItems?.find(
    (entry) => entry.id === input.itemId && entry.removed && entry.decision
  );
  if (withdrawn)
    return {
      reason: fail(
        `question_withdrawn: "${withdrawn.text}" is no longer needed${withdrawn.removedReason ? ` (${withdrawn.removedReason})` : ''}, so there is nothing to answer.`
      ),
    };
  const item = ask.doneItems?.find((entry) => entry.id === input.itemId && !entry.removed);
  if (!item)
    return {
      reason: fail(
        `item_not_found: ${input.itemId} is not on this checklist. ${neoKnownIds('items on it', checklist(ask))}`
      ),
    };
  if (input.option && !item.options?.includes(input.option))
    return { reason: fail('answer_option_unknown: use an option from this question.') };
  if (item.state !== 'needs_you')
    return {
      reason: fail(`item_not_waiting: ${item.id} is ${item.state}, not waiting on an answer.`),
    };
  return { value: { ask, item } };
}

export function requireNeoAnswerProvenance(
  input: z.infer<typeof Answer>,
  target: { ask: NeoAsk; item: NeoAskItem },
  caller: OperationCaller,
  cited: { id: string | null; at: number | null; text: string }
): Gate<{ ask: NeoAsk; item: NeoAskItem }> {
  if (caller.source !== 'mcp') return { value: target };
  if (!caller.neoTurn?.human || caller.neoTurn.consultationId || !caller.neoTurn.isLive())
    return {
      reason: fail(
        "answer_needs_human_turn: record the human's chat answer only in the live turn their own message started."
      ),
    };
  if (!cited.id)
    return {
      reason: fail(
        "answer_needs_human_message: record the human's chat answer in the turn their message started, or pass humanMessageId, the id of that message."
      ),
    };
  if (cited.at === null)
    return {
      reason: fail(
        `answer_not_from_human: ${cited.id} is not a message the human sent in this conversation.`
      ),
    };
  if (target.item.addedAt === null || cited.at <= target.item.addedAt)
    return {
      reason: fail(
        `answer_predates_question: ${cited.id} was sent before this question was asked, so it cannot answer it.`
      ),
    };
  const words = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  return words(cited.text).includes(words(input.choice))
    ? { value: target }
    : {
        reason: fail(
          `answer_not_in_message: "${input.choice}" is not in what the human wrote; pass their own words as the choice.`
        ),
      };
}

export function requireNeoAskEdit(input: z.infer<typeof Edit>, ask: NeoAsk): Gate<NeoAsk> {
  const active = activeNeoAskItems(ask);
  const missing = input.remove.filter((id) => !active.some((item) => item.id === id));
  if (missing.length)
    return {
      reason: fail(
        `item_not_found: ${missing.join(', ')} is not on this checklist. ${neoKnownIds('items on it', checklist(ask))}`
      ),
    };
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

export function requireNeoAskWritten(written: { ask: NeoAsk | null }): Gate<AskReceipt> {
  return written.ask
    ? { value: { ok: true, ask: written.ask } }
    : { reason: fail('This ask changed; read it again.') };
}

export function requireNeoOwnedLiveAsk(read: NeoAsk | Rejection): Gate<NeoAsk> {
  return 'ok' in read ? { reason: read } : { value: read };
}
