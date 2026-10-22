import { createCodingGithubReadOperation } from './github-read-operation.ts';
import type { NeoRefStateReader } from './ask-prs.ts';
import { createCodingRefReader } from './ref-reader.ts';
import { listNeoGithub, type NeoGithubLister } from './github-query.ts';
import { createCodingClaudeOwnerReader } from './claude-pr-owners.ts';
import { NEO_PACK_CODING_INSTRUCTIONS, NEO_PACK_CODING_WORKER_RULES } from '@hyperneo/prompts';
import { type CodingTodoPrRepository, createCodingTodoPack } from './todo-prs.ts';
import type { NeoPack, NeoPackBrief } from '../../pack-contract.ts';
import { routeNeoCardPrEvent } from './card-pr-events.ts';
import { prepareCodingExecution } from './prepare-execution.ts';
import {
  type CodingLedgerRead,
  type CodingPrLedgerRepository,
  readCodingLedgerRepo,
  reconcileCodingPrLedger,
} from './pr-ledger.ts';
import { type CodingPrEventRepository, deliverCodingPrEvents } from './pr-events.ts';
import { type CodingPrSweepRepository, type CodingSweepDeps, sweepCodingPrs } from './pr-sweep.ts';
import { type NeoWorkPrReader } from './work-prs.ts';
import { wakeCodingUnownedPrs } from './pr-unowned.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
  guidance: NEO_PACK_CODING_INSTRUCTIONS,
};

export function createCodingPack(deps: {
  readPrs: NeoWorkPrReader;
  readRefStates?: NeoRefStateReader;
  listGithub?: NeoGithubLister;
  todoPrs: CodingTodoPrRepository;
  prLedger: CodingPrLedgerRepository;
  prSweep: CodingPrSweepRepository;
  prEvents: CodingPrEventRepository;
  prSweepDeps: CodingSweepDeps;
  projectRepos: () => string[];
  readLedgerRepo?: CodingLedgerRead;
  readClaudeOwners?: ReturnType<typeof createCodingClaudeOwnerReader>;
}): NeoPack {
  const readClaudeOwners = deps.readClaudeOwners ?? createCodingClaudeOwnerReader();
  const ledgerSkips = new Map<string, number>();
  const todos = createCodingTodoPack(deps.todoPrs, deps.readPrs, (url) =>
    deps.prLedger.stateOf(url)
  );
  return {
    ...CODING_PACK_BRIEF,
    operations: [
      createCodingGithubReadOperation({
        readPrs: deps.readPrs,
        readRefStates: deps.readRefStates ?? createCodingRefReader(() => deps.prLedger.refFacts),
        listGithub:
          deps.listGithub ??
          (async (args) => ({ data: await listNeoGithub(args), at: new Date().toISOString() })),
      }),
    ],
    preferences: {
      mergePolicy: {
        label: { en: 'Merge policy', 'zh-Hans': '合并规则' },
        valueLabels: {
          review_bot: { en: 'CI and review bot approval', 'zh-Hans': 'CI 通过且审查机器人批准' },
          ci_only: { en: 'CI passes', 'zh-Hans': 'CI 通过' },
          human: { en: 'Human approval', 'zh-Hans': '人工批准' },
        },
        scope: 'repo',
        type: { kind: 'enum', values: ['review_bot', 'ci_only', 'human'] },
        default: 'human',
        ask: 'How are pull requests reviewed in this repository?',
      },
      reviewBot: {
        label: { en: 'Review bot', 'zh-Hans': '审查机器人' },
        valueLabels: {},
        scope: 'repo',
        type: { kind: 'login' },
        default: 'hyperneo-ai-test',
        ask: 'Which GitHub reviewer bot must approve?',
        askWhen: { key: 'mergePolicy', equals: 'review_bot' },
      },
      humanSignoff: {
        label: { en: 'Human sign-off paths or labels', 'zh-Hans': '人工审批路径或标签' },
        valueLabels: {
          '[]': {
            en: 'No extra human sign-off paths or labels',
            'zh-Hans': '无额外人工审批路径或标签',
          },
        },
        scope: 'repo',
        type: { kind: 'globs' },
        default: [],
        ask: 'Which paths or labels require human sign-off?',
      },
    },
    prepareExecution: prepareCodingExecution,
    todos,
    readFacts: todos.readFacts,
    judge: todos.judge,
    observeSessions: (sessions, now) => deps.prLedger.observeSessions(sessions, now),
    sweep: async (now) => {
      deps.prLedger.observeSessions(await readClaudeOwners(), now);
      const transitions = await reconcileCodingPrLedger(
        deps.prLedger,
        deps.projectRepos(),
        deps.readLedgerRepo ?? readCodingLedgerRepo,
        now,
        ledgerSkips
      );
      await deliverCodingPrEvents(deps.prEvents, transitions, deps.prSweepDeps);
      await wakeCodingUnownedPrs(deps.prEvents, deps.prSweepDeps.wake, now);
      await sweepCodingPrs(deps.prSweep, deps.prSweepDeps, now);
    },
    snapshotRows: (repos, now, openTodoIds) =>
      deps.prLedger.snapshot(
        repos,
        now,
        openTodoIds.flatMap((todoId) =>
          deps.todoPrs.prs(todoId).map((pr) => ({ todoId, url: pr.url, state: pr.state }))
        )
      ),
    instructions: () => NEO_PACK_CODING_INSTRUCTIONS,
    workerRules: NEO_PACK_CODING_WORKER_RULES,
    routeExternalEvent: (event, subscriptions) =>
      routeNeoCardPrEvent(event, subscriptions, (url) => deps.todoPrs.latest(url)),
  };
}
