import superpipe from 'superpipe';
import type { NeoAskRepository } from '../../storage/repositories/neo-ask-repository.ts';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import {
  planNeoAskTickStatus,
  neoPromptText,
  neoAsksOpenedBy,
  planNeoAskItems,
  isNeoAskHandedOver,
  neoAskNamedBy,
  neoAskLatestQuestionBefore,
  isNeoHumanDrop,
  neoAskOpenDecisions,
  isNeoAskReplay,
  planNeoAskSettle,
  neoAskSummary,
  planNeoAskWorkStops,
  neoAnswerCitation,
  readNeoAskReply,
  findNeoAskOpenQuestion,
  planNeoAskQuestion,
  planNeoAskRestate,
  readNeoHumanQuote,
  planNeoAskEdit,
  planNeoAskRemovedReason,
  planNeoAskFold,
} from './ask-plans.ts';
import type { NeoService } from './service.ts';
import type {
  NeoAdmit,
  AskReceipt,
  Rejection,
  NeoAskNameable,
  OpenRequest,
  Opening,
  AskOpened,
  NeoAskSettleFacts,
  NeoAskSettlePlan,
  NeoAskQuestionItem,
} from './ask-inputs.ts';
import type { z } from 'zod';
import type { NeoAskStateViewSchema } from './card-view-schema.ts';
import { NeoAskBindingError } from '../../storage/repositories/neo-ask-repository.ts';
import {
  fail,
  requireNeoAskOwner,
  requireNeoAskLive,
  requireNeoAskProject,
  requireNeoAskHumanTurn,
  requireNeoAskOriginFree,
  requireNeoAskUnnamed,
  requireRegisteredChecks,
  requireNeoAnswerItemsUnchecked,
  requireNeoAskReceipt,
  requireNeoAskSummary,
  requireNeoAskSettleable,
  requireNeoAskChecklistMet,
  requireNeoSettleKeepsOutcomeCards,
  requireNeoAskItemKind,
  requireNeoAskBecauseCard,
  requireNeoAskApprovalLapsed,
  requireNeoAskQuestionRoom,
  requireNeoAskSettleCarriesNoGate,
  requireNeoAskWritten,
  requireNeoOwnedLiveAsk,
  requireAskRevision,
  requireNeoAskTick,
  requireNeoMetReadEvidence,
  requireNeoAskDecisionKept,
  requireNeoAskQuestion,
  requireNeoAnswerProvenance,
  requireNeoAskQuestionAsked,
  requireNeoAskEdit,
  requireNeoAskScopeCut,
  requireNeoAskFoldTarget,
} from './ask-guards.ts';
import { NEO_ASK_ANSWER_PREFIX } from './ask-origin.ts';
import { neoAskAnswerChoice, neoHumanTickWakes } from './needs-you.ts';
import type { NeoWorkOrigin } from './work-origin.ts';
import type { PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import { requireNeoAskPack } from './packs/index.ts';
import { admitNeoWorkOrigin } from './work-origin.ts';
import {
  Settle,
  Tick,
  Answer,
  Question,
  Approve,
  Edit,
  Fold,
  AskResult,
  Open,
} from './ask-inputs.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { neoAskAnswerEvidence } from './ask-answer-evidence.ts';
import { defineOperation } from '../operations/registry.ts';
import { neoTurnRequestKey } from './request-key.ts';

export function writeNeoAskTickStatus(
  records: Pick<NeoAskRepository, 'settle' | 'reopen'>,
  ask: NeoAsk,
  plan: ReturnType<typeof planNeoAskTickStatus>
): NeoAsk | null {
  return plan.status === 'achieved'
    ? records.settle(ask, 'achieved', plan.outcome, plan.evidence)
    : plan.status === 'waiting'
      ? records.settle(ask, 'waiting', plan.outcome, plan.outcome, plan.item)
      : plan.status === 'open'
        ? records.reopen(ask)
        : ask;
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
      .flatMap((message) =>
        'inputKind' in message && message.inputKind === 'human'
          ? [neoPromptText(message)]
          : messageId.startsWith(NEO_ASK_ANSWER_PREFIX)
            ? (neoAskAnswerChoice(neoPromptText(message)) ?? [])
            : []
      );
  const nameable = (ask: NeoAsk): NeoAskNameable => ({
    id: ask.id,
    title: ask.title,
    cardIds: ask.workIds,
    refs: [
      ...ask.workIds.flatMap((id) => service.workPrs.get(id)?.prs.map((pr) => pr.url) ?? []),
      ...(ask.doneItems ?? []).flatMap((item) => (item.removed ? [] : (item.watch ?? []))),
    ],
  });
  const openNeoAsksOf = (origin: NeoWorkOrigin): NeoAskNameable[] =>
    service.askRecords
      .listLive()
      .filter(
        (ask) =>
          ask.originSessionId === origin.originSessionId &&
          ask.originMessageId !== origin.originMessageId
      )
      .map(nameable);
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
        requireNeoAskOwner(
          current.ask,
          caller,
          verb,
          '',
          neoAsksOpenedBy(service.askRecords.listLive(), caller)
        ),
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
  const replanAsk = (receipt: AskReceipt) => ({ ask: service.writeAskStatus(receipt.ask) });
  const open = (superpipe({})('neo.ask.open') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (input: OpenRequest, caller: OperationCaller) =>
        admit(caller, 'neo.ask.open', input.projectId),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: OpenRequest) => ({
        project: input.projectId ? service.repo.getProject(input.projectId) : null,
      }),
      'input',
      'project'
    )
    .pipe(requireNeoAskProject, ['input', 'project', 'admission'], 'result:admission')
    .pipe(
      (input: OpenRequest) => requireNeoAskPack(input.pack, service.packs()),
      'input',
      'result:admission'
    )
    .pipe((caller: OperationCaller) => service.ownsHumanMessage(caller), 'caller', 'owns')
    .pipe(requireNeoAskHumanTurn, ['caller', 'owns'], 'result:admission')
    .pipe(
      (input: OpenRequest, caller: OperationCaller) =>
        admitNeoWorkOrigin(
          caller,
          caller.sessionId ?? service.repo.getBindingForProject(input.projectId)?.sessionId
        ),
      ['input', 'caller'],
      'result:admission'
    )
    .pipe(
      (input: OpenRequest, origin: NeoWorkOrigin) =>
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
      (checklist: ReturnType<typeof planNeoAskItems>, origin: NeoWorkOrigin, input: OpenRequest) =>
        service.askRecords.forRequest(`${origin.originSessionId}:${input.requestKey}`)
          ? { value: origin }
          : requireRegisteredChecks(checklist.items, service.checkRegistry(), origin),
      ['checklist', 'admission', 'input'],
      'result:admission'
    )
    .pipe(
      (checklist: ReturnType<typeof planNeoAskItems>, origin: NeoWorkOrigin) =>
        requireNeoAnswerItemsUnchecked(checklist.items, origin),
      ['checklist', 'admission'],
      'result:admission'
    )
    .pipe(
      (
        checklist: ReturnType<typeof planNeoAskItems>,
        origin: NeoWorkOrigin,
        input: OpenRequest
      ) => {
        if (service.askRecords.forRequest(`${origin.originSessionId}:${input.requestKey}`))
          return { value: origin };
        const checked = service.outcomeCheckPolicy.requireChecks(
          input.doneItems ?? [{ text: checklist.doneWhen }],
          service.checkRegistry()
        );
        return 'reason' in checked ? checked : { value: origin };
      },
      ['checklist', 'admission', 'input'],
      'result:admission'
    )
    .pipe(
      (input: OpenRequest, checklist: ReturnType<typeof planNeoAskItems>): Opening => {
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
    .end('admission') as (input: OpenRequest, caller: OperationCaller) => AskOpened | Rejection;
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
        requireNeoAskOwner(
          current.ask,
          caller,
          'settle',
          '',
          neoAsksOpenedBy(service.askRecords.listLive(), caller)
        ),
      ['current', 'caller'],
      'result:admission'
    )
    .pipe(requireNeoAskSettleable, ['input', 'admission'], 'result:admission')
    .pipe(
      (input: z.infer<typeof Settle>, ask: NeoAsk, caller: OperationCaller) => {
        if (input.outcome !== 'abandoned' || !caller.neoTurn) return null;
        const prompt = service.db
          .getSDKMessageRepo()
          .getHumanPrompt(ask.originSessionId, caller.neoTurn.messageId);
        const about =
          !!prompt &&
          (neoAskNamedBy([prompt.text], nameable(ask)) ||
            neoAskLatestQuestionBefore(
              service.askRecords
                .listLive()
                .filter((live) => live.originSessionId === ask.originSessionId),
              prompt.at
            ) === ask.id);
        return isNeoHumanDrop(
          caller,
          service.ownsHumanMessage(caller),
          about,
          neoAskOpenDecisions(ask),
          prompt
        )
          ? { text: prompt!.text }
          : null;
      },
      ['input', 'admission', 'caller'],
      'drop'
    )
    .pipe(requireNeoAskChecklistMet, ['input', 'admission', 'caller', 'drop'], 'result:admission')
    .pipe(
      (ask: NeoAsk) => ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []),
      'admission',
      'cards'
    )
    .pipe(
      (input: z.infer<typeof Settle>, ask: NeoAsk, caller: OperationCaller, cards: NeoWork[]) =>
        isNeoAskReplay(ask, input)
          ? { value: ask }
          : requireNeoSettleKeepsOutcomeCards(caller, input.outcome, ask, cards, ask),
      ['input', 'admission', 'caller', 'cards'],
      'result:admission'
    )
    .pipe(
      (cards: NeoWork[]): NeoAskSettleFacts => ({
        offered: cards.some((card) => card.status === 'proposed'),
        stalled: false,
        failed: cards.some((card) => card.status === 'failed'),
      }),
      'cards',
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
      (input: z.infer<typeof Settle>, ask: NeoAsk) =>
        requireNeoAskBecauseCard(input.because, ask, ask),
      ['input', 'admission'],
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
      (
        input: z.infer<typeof Settle>,
        ask: NeoAsk,
        plan: NeoAskSettlePlan,
        drop: { text: string } | null
      ) => {
        if (isNeoAskReplay(ask, input)) return { ask };
        const lost = new Error('neo-ask-settle-lost');
        try {
          return service.db.getDatabase().transaction(() => {
            if (plan.restate) service.askRecords.restateQuestion(ask.id, plan.restate, Date.now());
            const settled = service.askRecords.settle(
              ask,
              input.outcome,
              neoAskSummary(input),
              input.evidence,
              plan.waitingItem,
              plan.item,
              false,
              drop && `The human dropped this ask: "${drop.text}"`
            );
            if (!settled) throw lost;
            return { ask: settled };
          })();
        } catch (error) {
          if (error !== lost) throw error;
          return { ask: null };
        }
      },
      ['input', 'admission', 'plan', 'drop'],
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
      (target: { ask: NeoAsk }) =>
        target.ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []),
      'admission',
      'cards'
    )
    .pipe(
      (
        input: z.infer<typeof Tick>,
        target: { item: NeoAskItem },
        caller: OperationCaller,
        cards: NeoWork[]
      ) => requireNeoMetReadEvidence(caller, input.state, target.item, cards, target),
      ['input', 'admission', 'caller', 'cards'],
      'result:admission'
    )
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
      ) => requireNeoAskDecisionKept(target.ask, caller, [input.itemId], target),
      ['input', 'admission', 'caller'],
      'result:admission'
    )
    .pipe(
      (
        input: z.infer<typeof Tick>,
        target: { ask: NeoAsk; item: NeoAskItem },
        caller: OperationCaller
      ) => {
        const written = service.askRecords.tickItem(
          target.ask.id,
          {
            ...target.item,
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
    .pipe(
      (input: z.infer<typeof Answer>, target: { ask: NeoAsk }, caller: OperationCaller) => {
        const id = neoAnswerCitation(input, caller);
        const prompt = id
          ? service.db.getSDKMessageRepo().getHumanPrompt(target.ask.originSessionId, id)
          : null;
        return { id, at: prompt?.at ?? null, text: prompt?.text ?? '' };
      },
      ['input', 'admission', 'caller'],
      'cited'
    )
    .pipe(requireNeoAnswerProvenance, ['input', 'admission', 'caller', 'cited'], 'result:admission')
    .pipe((target: { ask: NeoAsk; item: NeoAskItem }) => target, 'admission', 'answerTarget')
    .pipe(readNeoAskReply, 'input', 'reply')
    .pipe(
      async (
        target: { ask: NeoAsk; item: NeoAskItem },
        reply: { choice: string; met: boolean },
        caller: OperationCaller
      ) => {
        if (caller.source !== 'mcp')
          await service.deliverAskAnswer(target.ask, target.item, reply.choice, reply.met);
      },
      ['admission', 'reply', 'caller']
    )
    .pipe(
      (
        input: z.infer<typeof Answer>,
        target: { ask: NeoAsk; item: NeoAskItem },
        reply: { choice: string; met: boolean },
        cited: { id: string | null; at: number | null }
      ) => {
        const answeredAt = cited.at ?? Date.now();
        const written =
          !reply.met ||
          service.askRecords.tickItem(
            target.ask.id,
            {
              ...target.item,
              id: input.itemId,
              state: 'met',
              evidence: neoAskAnswerEvidence(reply.choice, cited.id, input.option, answeredAt),
              metBy: 'human',
            },
            answeredAt,
            target.ask.doneItems?.find((item) => item.id === input.itemId),
            true
          );
        return { ask: written ? service.askRecords.get(target.ask.id) : null };
      },
      ['input', 'admission', 'reply', 'cited'],
      'answered'
    )
    .pipe(requireNeoAskWritten, 'answered', 'result:admission')
    .pipe(
      (input: z.infer<typeof Answer>, target: { ask: NeoAsk; item: NeoAskItem }) =>
        service.answerStartQuestion(target.ask, target.item, input.option ?? input.choice),
      ['input', 'answerTarget'],
      'started'
    )
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
        requireNeoAskBecauseCard(input.because, ask, ask),
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
        findNeoAskOpenQuestion(ask, input.question, input.decides),
      ['input', 'admission'],
      'asked'
    )
    .pipe(
      (input: z.infer<typeof Question>, ask: NeoAsk, asked: NeoAskItem | null) =>
        asked ? null : planNeoAskQuestion(ask, input),
      ['input', 'admission', 'asked'],
      'item'
    )
    .pipe(planNeoAskRestate, ['asked', 'input'], 'restate')
    .pipe(
      (ask: NeoAsk, item: NeoAskQuestionItem | null) => requireNeoAskQuestionRoom(ask, item, ask),
      ['admission', 'item'],
      'result:admission'
    )
    .pipe(
      (
        ask: NeoAsk,
        item: NeoAskQuestionItem | null,
        restate: ReturnType<typeof planNeoAskRestate>,
        asked: NeoAskItem | null
      ) => {
        if (item)
          return {
            ask: service.askRecords.settle(ask, 'waiting', item.text, item.text, item.id, item),
          };
        if (restate) service.askRecords.restateQuestion(ask.id, restate, Date.now());
        const current = restate ? service.askRecords.get(ask.id) : ask;
        const text = restate?.text ?? asked?.text;
        return {
          ask:
            current?.status === 'open' && asked && text
              ? service.askRecords.settle(current, 'waiting', text, text, asked.id)
              : current,
        };
      },
      ['admission', 'item', 'restate', 'asked'],
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
      (receipt: AskReceipt) => service.startApprovedWork(receipt.ask.workIds),
      'admission',
      'started'
    )
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
      (input: z.infer<typeof Edit>, ask: NeoAsk) =>
        requireNeoAnswerItemsUnchecked(
          [
            ...input.add,
            ...input.track.flatMap((change) => {
              const item = ask.doneItems?.find((entry) => entry.id === change.itemId);
              return item ? [{ ...item, check: change.check ?? null, watch: change.watch }] : [];
            }),
          ],
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
        const checked = service.outcomeCheckPolicy.requireChecks(
          [...input.add, ...tracked.values()],
          service.checkRegistry()
        );
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
    .pipe(
      (input: z.infer<typeof Edit>, caller: OperationCaller) =>
        input.remove.length && caller.source === 'mcp' && caller.sessionId && caller.neoTurn
          ? humanText(caller.sessionId, caller.neoTurn.messageId)
          : [],
      ['input', 'caller'],
      'said'
    )
    .pipe(readNeoHumanQuote, ['input', 'caller', 'said'], 'quote')
    .pipe(requireNeoAskScopeCut, ['input', 'admission', 'caller', 'quote'], 'result:admission')
    .pipe(planNeoAskEdit, ['admission', 'input'], 'plan')
    .pipe(planNeoAskRemovedReason, ['input', 'caller', 'quote'], 'removedReason')
    .pipe(
      (ask: NeoAsk, plan: ReturnType<typeof planNeoAskEdit>, removedReason: string | null) => {
        const written = service.askRecords.editItems(
          ask.id,
          { ...plan, removedReason },
          Date.now(),
          ask.revision ?? 0
        );
        return { ask: written ? service.askRecords.get(ask.id) : null };
      },
      ['admission', 'plan', 'removedReason'],
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
        'Inspect current asks and reuse the one for this request before opening another. Record a new human request and what done means for it, from the current live input, before proposing its work. ask is the request in their words; doneItems is the checklist that finishes it, one checkable outcome per item; every doneItem declares check: a registered check kind the daemon ticks it from, or null when you tick it yourself (doneWhen alone is refused, because its lines declare no check); doneSource is "human" when the human said it, or the id of the standing rule it came from. pack optionally names the enabled domain pack this ask works under (coding for software work in git repositories); its guidance comes back as packBriefing, and neo.pack.read {id} returns it in full. An item that waits on GitHub pull requests or issues passes watch, their URLs: the daemon ticks it met itself when every watched pull request has merged (on the merge event) and every watched issue has closed, with the event or read states as evidence. A deploy item passes check coding.deployed (watch optionally names the pull requests; otherwise the ask’s card PRs): the daemon ticks it once every daemon, this one and each attached one, runs a commit containing their merge commits. Propose every work item for this request with its askId. An ask opened in a turn the human sent records approval of that plan revision. Execution proposals still require the grouped start question’s answer for their exact cards and targets. Approval never covers deploying to production, deleting data or other destructive steps.',
      inputSchema: Open,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) =>
        withBindingView(() =>
          open(
            {
              ...input,
              requestKey: neoTurnRequestKey(caller, 'neo.ask.open', input),
            },
            caller
          )
        ),
    }),
    defineOperation({
      name: 'neo.ask.tick',
      description:
        "Tick one item of an ask's done checklist (neo.snapshot returns ask.doneItems): met with the evidence that shows it, only for an item the daemon cannot read (never for a part the human dropped: remove that item with neo.ask.edit), reported when a working agent says it is done but nobody can read it (a physical change: an agent's word never makes an item met, and the ask cannot be achieved until the human confirms it), or back to pending. An item with a check or watch, a card-bound merge included, is ticked by the daemon from what it reads: ticking it met or reported returns the item unchanged with a note saying so. needs_you is refused: a decision or a check only the human can make is its own item, asked with neo.ask.question. met is refused for an item a card delivers (deliveredBy) until that card has reported. Only the Neo session that opened the ask or the user can tick it.",
      inputSchema: Tick,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await tick(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.question',
      description:
        'Read the existing questions and recorded answers first. For the same decision during a minor replan, retain its question identity and answer; do not create another question for changed wording or implementation details. A genuinely different decision or execution target needs its own question. Ask the human one question about this ask: the only way a decision, or a check only they can make, reaches them. question is one short question worded for this step; options are optional 2-4 short answers, ordered negative/decline first (left), positive/agree last (right), which become their buttons; omit options for an open question answered in chat; kind is required, decision (any answer settles it) or action (a question about the result of a step). The question becomes its own checklist item and the ask waits on it; their answer ticks it met and is sent back to you, so act on it then. For a step only the human can check (on a device, or a machine the daemon cannot read), ask about its result with kind action and options written for that step in its own words, negative first and positive last ("这一步成功了吗？" with "没成功" and "成功了"): every answer completes this question; ask a new question only if a new decision is needed. Approval expiry and stalled cards do not create a separate human control. decides names the decision it asks: asking the same decision again, in any words, restates its open question (new wording and options) instead of adding another, and a different decision is its own question. When a card under this ask is why you ask, pass because {card, reason}: the daemon withdraws the question as no longer needed once that reason is gone (never as answered), and a late answer to it is refused. Only the Neo session that opened the ask or the user can ask on it.',
      inputSchema: Question,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await question(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.answer',
      description:
        "Answer a question on an ask (neo.ask.question): the human's choice (one of its options, or their own words) ticks the item met. From the Answer control it is sent to the Neo session that opened the ask, which acts on it. When the human answers in chat instead, Neo records it here in the turn their message started (or passes humanMessageId, the id of an earlier human message that answered it): the daemon accepts it only in the live turn the human's message started, only if that message is the human's own, in this ask's conversation and sent after the question, and only if choice appears in what they wrote (pass their own words), so never ask them to repeat it in a control and never open a second ask for it. For a grouped start question, pass option with the question label matching their own words, keeping choice verbatim; omit option when their meaning is unclear, so execution consent stays pending. Every answer, including a negative result, completes the question with no confirmation step.",
      inputSchema: Answer,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await answer(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.approve',
      description:
        'Approve the current plan revision of an open ask. Only the user can call this operation. Proposed cards with grouped start questions still require their own neo.ask.answer receipt for the exact cards and targets; ask-wide approval does not answer those questions or approve later proposals or changed targets. The daemon starts only cards already admitted by their recorded consent. An approval never covers deploying to production, deleting data or other destructive steps.',
      inputSchema: Approve,
      resultSchema: AskResult,
      policy: { safetyClass: 'human_only' },
      execute: async (input, caller) => withView(await approve(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.edit',
      description:
        'Inspect existing items, cards and answers before changing an open ask. Reuse them for the same work during a minor replan; preserve the existing question and answer, and compare new items for duplicates. A refusal is a fact to inspect and repair, not a question to send back to the human. Keep internal item IDs in tool arguments and use titles or outcome text in human-facing prose. Change the done checklist when what done means changes: bind [{itemId, deliveredBy}] links an outcome to a card on this ask (null removes it), invalidating its evidence and approval; material changes are refused after dispatch. add items (each can pass watch, GitHub pull request or issue URLs the daemon ticks it met on, and check, as in neo.ask.open), remove ones that no longer apply (an unfinished outcome only in the turn where the human tells you to drop it, with humanSaid quoting their words from that message; it stays listed as removed with that reason, and anything else is refused), or track open items: track [{itemId, watch, check}] sets what the daemon reads for an item already listed, so the daemon ticks it instead of you. New outcomes and changed tracking require the matching coding.pr_merged/coding.deployed check for PR merge or deploy outcomes; untouched legacy items stay unchanged. Removed items stay listed as removed, so the change is visible; never reword an item by removing and re-adding it silently, say why in your reply. Only the Neo session that opened the ask or the user can edit it.',
      inputSchema: Edit,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withBindingView(() => edit(input, caller)),
    }),
    defineOperation({
      name: 'neo.ask.settle',
      description:
        "Settle an ask when its outcome is decided: achieved when every checklist item is ticked met with neo.ask.tick (refused otherwise; the user's close still overrides); waiting when the next step is the human's, never achieved while a question waits on them, and abandoned then only in the turn the human's own message drops the ask, which closes their open questions with their words; blocked when only the human can unblock it; abandoned when it is no longer wanted. waiting and blocked need something the human can act on: an open question, work offered for Start, a reported item, a failed or stalled card, or an expired approval. Otherwise pass question, decides (the decision it asks) and options (2-4 short answers), which ask it as neo.ask.question does, with kind decision or action (approval and wait are refused); a settle never carries a free-text gate. Asking for renewed approval is refused while the approval is active and no card has stalled. summary is one short sentence the ask shows (\"Merged in #6099.\", \"Start the composer redesign?\"). evidence holds the proof (PR state, commits, checks), which the ask does not show. Achieved and abandoned are final and stop the ask's live work: queued work items close (done for achieved, cancelled for abandoned) and proposed work items are cancelled. Proposing, starting or continuing work under a waiting or blocked ask reopens it. Only the Neo session that opened the ask or the user can settle it; the user's close button calls this too.",
      inputSchema: Settle,
      resultSchema: AskResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input, caller) => withView(await settle(input, caller)),
    }),
  ];
}
