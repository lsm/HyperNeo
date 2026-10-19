import { NEO_PACK_CODING_INSTRUCTIONS, NEO_PACK_CODING_WORKER_RULES } from '@hyperneo/prompts';
import { type CodingTodoPrRepository, createCodingTodoPack } from './todo-prs.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ExternalEvent } from '../../../external-events/types.ts';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';
import type { NeoEvidence } from '../../evidence.ts';
import type { NeoPack, NeoPackBrief, NeoPackCheck } from '../types.ts';
import {
  type NeoRefStateReader,
  neoAskCardRefs,
  neoAskRefNews,
  neoAskReportRefs,
} from './ask-prs.ts';
import { neoCardPrFacts } from './card-facts.ts';
import {
  keepNeoCardPrReads,
  keepNeoUnbeatenPrs,
  type NeoCardPrCandidate,
  type NeoCardPrOwned,
  type NeoPrClaimRow,
  planNeoCardPrOwnership,
  planNeoPrCedes,
  scoreNeoCardPrs,
} from './card-pr-claims.ts';
import { neoCardPrTopics, routeNeoCardPrEvent } from './card-pr-events.ts';
import {
  CODING_CHECK_DEPLOYED,
  type NeoDeployReader,
  readNeoDeployTicks,
} from './deploy-checks.ts';
import {
  CODING_CHECK_ISSUE_CLOSED,
  CODING_CHECK_ISSUE_FILED,
  CODING_CHECK_ISSUE_SUB_ISSUE,
  readNeoIssueTicks,
} from './issue-checks.ts';
import type { NeoWorkPrClaimRepository } from './neo-work-pr-claim-repository.ts';
import type { NeoWorkPrRepository, NeoWorkPrRow } from './neo-work-pr-repository.ts';
import { prepareCodingExecution } from './prepare-execution.ts';
import {
  type CodingLedgerRead,
  type CodingPrLedgerRepository,
  readCodingLedgerRepo,
  reconcileCodingPrLedger,
} from './pr-ledger.ts';
import { type CodingPrEventRepository, deliverCodingPrEvents } from './pr-events.ts';
import { type CodingPrSweepRepository, type CodingSweepDeps, sweepCodingPrs } from './pr-sweep.ts';
import { readCodingPrerequisiteBase } from './prerequisite-base.ts';
import {
  CODING_CHECK_PR_MERGED,
  neoWatchTopics,
  readNeoWatchEventTicks,
  readNeoWatchTicks,
} from './watch-checks.ts';
import {
  extractNeoWorkPrUrls,
  isNeoWorkPrEvidenceOpened,
  mergeNeoWorkPrReads,
  type NeoWorkPrReader,
  neoAskPrEvidence,
  neoWorkPrEvidence,
  shouldReadNeoWorkPrs,
} from './work-prs.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
  guidance: NEO_PACK_CODING_INSTRUCTIONS,
};

export const codingPrMergedCheck: NeoPackCheck = () => ({ reason: 'watch_required' });

const CODING_CHECK_PR_OPENED = 'coding.pr_opened';

export const codingPrOpenedCheck: NeoPackCheck = (item, evidence: readonly NeoEvidence[]) => {
  if (item.deliveredBy) return { reason: 'card_bound' };
  const opened = evidence.filter(isNeoWorkPrEvidenceOpened);
  return opened.length
    ? { value: `Opened: ${opened.map((pr) => pr.key).join(', ')}` }
    : { reason: 'not_opened' };
};

export interface NeoCardPrDeps {
  readPrs: NeoWorkPrReader;
  prCandidates: (work: NeoWork, stored: NeoWorkPrRow | null) => Promise<NeoCardPrCandidate[]>;
  claims: Pick<NeoWorkPrClaimRepository, 'forUrls' | 'replace' | 'drop'> &
    Partial<Pick<NeoWorkPrClaimRepository, 'markReclaimed'>>;
  workPrs: Pick<NeoWorkPrRepository, 'get' | 'list' | 'recordFailedRead'>;
  record: (
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null,
    read?: boolean
  ) => NeoWorkPrRow | null;
}

type NeoCardPrRead = { row: NeoWorkPrRow | null; ok: boolean };
type NeoCardPrPlan = { owned: NeoCardPrOwned[] };

const ownedUrls = (plan: NeoCardPrPlan) => plan.owned.map((item) => item.url);
const stripReadTimes = (prs: readonly NeoWorkPr[]) =>
  prs.map(({ createdAt: _createdAt, title: _title, branch: _branch, refs: _refs, ...pr }) => pr);

export function cachedNeoCardPrRead(row: NeoWorkPrRow | null): NeoCardPrRead {
  return { row, ok: !row || row.readOkAt >= row.readAt };
}

export function neoCardPrsFresh(
  current: { row: NeoWorkPrRow | null },
  plan: NeoCardPrPlan,
  now: number,
  force = false
): boolean {
  return (
    !force &&
    !shouldReadNeoWorkPrs(current.row, ownedUrls(plan), now) &&
    plan.owned.every(
      (item) => item.claimed && (item.scope === undefined || item.scoped || item.claim === 'named')
    )
  );
}

export const readNeoCardPrs = (superpipe({})('neo-card-pr-read') as PipelineAPI)
  .input(['deps', 'work', 'stored', 'now', 'force'])
  .pipe(
    async (deps: NeoCardPrDeps, work: NeoWork, stored: NeoWorkPrRow | null) => ({
      candidates: await deps.prCandidates(work, stored),
    }),
    ['deps', 'work', 'stored'],
    'found'
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      found: { candidates: NeoCardPrCandidate[] },
      now: number
    ) => ({
      owned: planNeoCardPrOwnership(
        work,
        found.candidates,
        deps.claims.forUrls(found.candidates.map((item) => item.url)),
        now
      ),
    }),
    ['deps', 'work', 'found', 'now'],
    'plan'
  )
  .pipe(
    (deps: NeoCardPrDeps, work: NeoWork, stored: NeoWorkPrRow | null, plan: NeoCardPrPlan) => {
      const keep = new Set(ownedUrls(plan).map(githubUrlKey));
      const kept = stored?.prs.filter((pr) => keep.has(githubUrlKey(pr.url))) ?? [];
      if (!stored || kept.length === stored.prs.length) return { row: stored };
      deps.claims.replace(
        work.id,
        plan.owned.filter((item) => item.claimed)
      );
      return { row: deps.record(work.id, kept, stored, false) ?? stored };
    },
    ['deps', 'work', 'stored', 'plan'],
    'current'
  )
  .pipe(
    (current: { row: NeoWorkPrRow | null }) => ({ value: cachedNeoCardPrRead(current.row) }),
    ['current'],
    'result:read'
  )
  .pipe(neoCardPrsFresh, ['current', 'plan', 'now', 'force'], 'fresh')
  .pipe('!fresh')
  .pipe(
    async (deps: NeoCardPrDeps, plan: NeoCardPrPlan) => ({
      prs: await deps.readPrs(ownedUrls(plan)),
    }),
    ['deps', 'plan'],
    'fetched'
  )
  .pipe(
    (deps: NeoCardPrDeps, work: NeoWork, fetched: { prs: NeoWorkPr[] | null }, now: number) => {
      if (!fetched.prs) deps.workPrs.recordFailedRead(work.id, now);
    },
    ['deps', 'work', 'fetched', 'now']
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      plan: NeoCardPrPlan,
      fetched: { prs: NeoWorkPr[] | null }
    ) =>
      keepNeoUnbeatenPrs(
        work,
        scoreNeoCardPrs(work, plan.owned, fetched.prs ?? []),
        deps.claims.forUrls(ownedUrls(plan))
      ),
    ['deps', 'work', 'plan', 'fetched'],
    'unbeaten'
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      current: { row: NeoWorkPrRow | null },
      unbeaten: NeoCardPrPlan & { beaten: NeoCardPrOwned[] },
      fetched: { prs: NeoWorkPr[] | null }
    ) => {
      if (!fetched.prs) return { value: { row: current.row, ok: false } };
      const { kept, pending, rejected } = keepNeoCardPrReads(work, unbeaten.owned, fetched.prs);
      const outmatched = unbeaten.beaten.filter((item) => item.claim === 'mentioned');
      deps.claims.replace(work.id, [
        ...kept,
        ...[...rejected, ...outmatched].map((item) => ({ ...item, claim: 'rejected' as const })),
      ]);
      const prs = mergeNeoWorkPrReads(
        [...kept, ...pending.filter((item) => item.scope === undefined)].map((item) => item.url),
        fetched.prs,
        current.row?.prs
      );
      return {
        value: {
          row: deps.record(work.id, stripReadTimes(prs), current.row),
          ok: true,
        },
      };
    },
    ['deps', 'work', 'current', 'unbeaten', 'fetched'],
    'result:read'
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      found: { candidates: NeoCardPrCandidate[] },
      unbeaten: NeoCardPrPlan,
      fetched: { prs: NeoWorkPr[] | null },
      read: NeoCardPrRead,
      force: boolean | undefined
    ) => {
      if (!force || !read.ok) return;
      const owned = new Set(ownedUrls(unbeaten).map(githubUrlKey));
      const observed = new Set((fetched.prs ?? []).map((pr) => githubUrlKey(pr.url)));
      deps.claims.markReclaimed?.(
        work.id,
        found.candidates.filter(
          (candidate) =>
            !owned.has(githubUrlKey(candidate.url)) || !observed.has(githubUrlKey(candidate.url))
        )
      );
    },
    ['deps', 'work', 'found', 'unbeaten', 'fetched', 'read', 'force']
  )
  .pipe(
    (deps: NeoCardPrDeps, work: NeoWork, read: NeoCardPrRead) => ({
      rows: planNeoPrCedes(work, deps.claims.forUrls(read.row?.prs.map((pr) => pr.url) ?? [])),
    }),
    ['deps', 'work', 'read'],
    'ceded'
  )
  .pipe(
    (deps: NeoCardPrDeps, ceded: { rows: NeoPrClaimRow[] }) => {
      for (const lost of ceded.rows) {
        const row = deps.workPrs.get(lost.workId);
        const prs = row?.prs.filter((pr) => githubUrlKey(pr.url) !== lost.urlKey);
        if (row && prs && prs.length !== row.prs.length) deps.record(lost.workId, prs, row, false);
        deps.claims.drop(lost.workId, lost.urlKey, lost.claim);
      }
    },
    ['deps', 'ceded']
  )
  .endAsync('read') as (
  deps: NeoCardPrDeps,
  work: NeoWork,
  stored: NeoWorkPrRow | null,
  now: number,
  force?: boolean
) => Promise<NeoCardPrRead>;

export function createCodingPack(
  deps: NeoCardPrDeps & {
    runningPrUrls: (workIds: readonly string[]) => Promise<string[]>;
    cardReports: (workIds: readonly string[]) => string[];
    readRefStates: NeoRefStateReader;
    readDeploys: NeoDeployReader;
    readMergeCommit: (url: string) => Promise<string | null>;
    cardBase: (workId: string) => string | null;
    cardStartedAt?: (workId: string) => number | null;
    todoPrs: CodingTodoPrRepository;
    prLedger: CodingPrLedgerRepository;
    prSweep: CodingPrSweepRepository;
    prEvents: CodingPrEventRepository;
    prSweepDeps: CodingSweepDeps;
    projectRepos: () => string[];
    readLedgerRepo?: CodingLedgerRead;
  }
): NeoPack {
  const cardPrs = (workId: string) => deps.workPrs.get(workId)?.prs ?? [];
  const ledgerSkips = new Map<string, number>();
  const { readRefStates, cardBase, cardStartedAt } = deps;
  return {
    ...CODING_PACK_BRIEF,
    prepareExecution: prepareCodingExecution,
    todos: createCodingTodoPack(deps.todoPrs, deps.readPrs, (url) => deps.prLedger.stateOf(url)),
    observeSessions: (sessions, now) => deps.prLedger.observeSessions(sessions, now),
    sweep: async (now) => {
      const transitions = await reconcileCodingPrLedger(
        deps.prLedger,
        deps.projectRepos(),
        deps.readLedgerRepo ?? readCodingLedgerRepo,
        now,
        ledgerSkips
      );
      await deliverCodingPrEvents(deps.prEvents, transitions, deps.prSweepDeps);
      await sweepCodingPrs(deps.prSweep, deps.prSweepDeps, now);
    },
    snapshotRows: (repos, now, openTodoIds) =>
      deps.prLedger.snapshot(
        repos,
        now,
        openTodoIds.flatMap((todoId) =>
          deps.todoPrs.urls(todoId).map((url) => ({
            todoId,
            url,
            state: deps.todoPrs.latest(url)?.pr.state ?? null,
          }))
        )
      ),
    prerequisiteParameters: (items) =>
      readCodingPrerequisiteBase(items, {
        readRefStates: deps.readRefStates,
        readMergeCommit: deps.readMergeCommit,
        cardBase: deps.cardBase,
      }),
    instructions: () => NEO_PACK_CODING_INSTRUCTIONS,
    workerRules: NEO_PACK_CODING_WORKER_RULES,
    checks: {
      [CODING_CHECK_PR_MERGED]: codingPrMergedCheck,
      [CODING_CHECK_PR_OPENED]: codingPrOpenedCheck,
    },
    checkEvidence: {
      [CODING_CHECK_PR_MERGED]: { independent: true },
      [CODING_CHECK_PR_OPENED]: { independent: true },
    },
    askTickChecks: [
      CODING_CHECK_ISSUE_FILED,
      CODING_CHECK_ISSUE_SUB_ISSUE,
      CODING_CHECK_ISSUE_CLOSED,
      CODING_CHECK_DEPLOYED,
    ],
    externalTopics: (work: NeoWork) => neoCardPrTopics(deps.workPrs.get(work.id)?.prs ?? []),
    routeExternalEvent: (event, subscriptions) =>
      routeNeoCardPrEvent(event, subscriptions, (url) => deps.todoPrs.latest(url)),
    cardFacts: (workId: string, stale: boolean) =>
      neoCardPrFacts(deps.workPrs.get(workId)?.prs, stale),
    readEvidence: async (work: NeoWork, changedAt?: number | null) => {
      const stored = deps.workPrs.get(work.id);
      const { row, ok } = await readNeoCardPrs(
        deps,
        work,
        stored,
        Date.now(),
        (changedAt ?? 0) > (stored?.readAt ?? 0)
      );
      return row?.prs.length
        ? { evidence: neoWorkPrEvidence(row.prs), read: { ok, okAt: row.readOkAt } }
        : null;
    },
    askCardEvidence: (ask: NeoAsk, works: readonly NeoWork[]) =>
      neoAskPrEvidence(
        works,
        deps.workPrs.list(ask.workIds),
        deps.claims.forUrls(works.flatMap((work) => extractNeoWorkPrUrls(work.report)))
      ),
    readAskTicks: async (ask: NeoAsk, works: readonly NeoWork[]) => [
      ...(await readNeoIssueTicks(ask, works, deps.readRefStates, Date.now())),
      ...(await readNeoDeployTicks(
        ask,
        deps.workPrs.list(ask.workIds).flatMap((row) => row.prs.map((pr) => pr.url)),
        deps.readDeploys,
        Date.now()
      )),
    ],
    readAskWatchTicks: (ask: NeoAsk) =>
      readNeoWatchTicks(ask, readRefStates, Date.now(), cardBase, cardPrs, cardStartedAt),
    readAskEventTicks: (ask: NeoAsk, event: ExternalEvent) =>
      readNeoWatchEventTicks(ask, event, readRefStates, cardBase, cardPrs, cardStartedAt),
    askTopics: (ask: NeoAsk) => neoWatchTopics(ask, cardPrs),
    readAskEvidence: async (ask: NeoAsk) => {
      const tracked = deps.workPrs.list(ask.workIds).flatMap((row) => row.prs.map((pr) => pr.url));
      const refs = neoAskCardRefs(
        neoAskReportRefs(ask, deps.cardReports(ask.workIds), tracked),
        await deps.runningPrUrls(ask.workIds),
        tracked
      );
      return refs.length ? neoAskRefNews(await deps.readRefStates(refs), ask.createdAt) : [];
    },
  };
}
