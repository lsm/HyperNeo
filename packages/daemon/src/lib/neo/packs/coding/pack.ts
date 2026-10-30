import { createCodingHumanMergeOperation } from './human-merge-operation.ts';
import { createCodingDaemonMergeSweep } from './daemon-merge-sweep.ts';
import { checkCodingPrApproved } from './pr-approved.ts';
import { withCodingMergeContext } from './merge-context.ts';
import { codingWatchedRepos, initializeCodingWatches } from './watched-repos.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { createCodingPrFileOperation } from './pr-file-operation.ts';
import { runCodingReview } from './review.ts';
import { withCodingWorkGoal } from './work-goal.ts';
import { withCodingWorkerProvenance } from './worker-provenance.ts';
import { createCodingGithubReadOperation } from './github-read-operation.ts';
import type { NeoRefStateReader } from './ask-prs.ts';
import { createCodingRefReader } from './ref-reader.ts';
import { listNeoGithub, type NeoGithubLister } from './github-query.ts';
import { createCodingClaudeOwnerReader } from './claude-pr-owners.ts';
import { NEO_PACK_CODING_INSTRUCTIONS, NEO_PACK_CODING_WORKER_RULES } from '@hyperneo/prompts';
import { type CodingTodoPrRepository, createCodingTodoPack } from './todo-prs.ts';
import type { NeoPack, NeoPackBrief } from '../../pack-contract.ts';
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
import { recordCodingSmoke } from './delivery-facts.ts';
import { readCodingDaemonMergeFacts } from './daemon-merge-facts.ts';
import { decideCodingDaemonMerge } from './daemon-merge-gates.ts';
import { prepareCodingMerge } from './merge-gates.ts';
import { deliverCodingHealth } from './health-delivery.ts';
import { CODING_STAGE_PREFERENCES, createCodingWritePlanOperation } from './stage-preferences.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe:
    'Software work in git repositories: pull requests, CI, review and merging. Check pr_approved {url} waits for saved-policy approval; pr_merged waits for merge.',
  guidance: NEO_PACK_CODING_INSTRUCTIONS,
};

export function createCodingPack(deps: {
  database: () => Database;
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
}): NeoPack & {
  readMergeFacts: typeof readCodingDaemonMergeFacts;
  decideMerge: typeof decideCodingDaemonMerge;
  recordSmoke: typeof recordCodingSmoke;
  prepareMerge: typeof prepareCodingMerge;
  review: typeof runCodingReview;
} {
  const readClaudeOwners = deps.readClaudeOwners ?? createCodingClaudeOwnerReader();
  const workerContext = (text: string) =>
    withCodingMergeContext(text, deps.prLedger.policyContext(text, deps.projectRepos()));
  const notificationContext = async (text: string) =>
    withCodingMergeContext(text, await deps.prLedger.policyContextCurrent(text));
  const prSweepDeps: CodingSweepDeps = {
    tell: async (ref, key, text) =>
      deps.prSweepDeps.tell(ref, key, await notificationContext(text)),
    wake: async (key, text) => deps.prSweepDeps.wake(key, await notificationContext(text)),
  };
  const mergeSweep = createCodingDaemonMergeSweep(
    deps.database,
    deps.prLedger,
    deps.prEvents,
    prSweepDeps
  );
  const todos = createCodingTodoPack(
    deps.todoPrs,
    deps.readPrs,
    (url) => deps.prLedger.stateOf(url),
    deps.readRefStates ?? createCodingRefReader(() => deps.prLedger.refFacts),
    (url) => checkCodingPrApproved(url, (repo) => deps.prLedger.policy(repo))
  );
  return {
    ...CODING_PACK_BRIEF,
    readMergeFacts: readCodingDaemonMergeFacts,
    decideMerge: decideCodingDaemonMerge,
    recordSmoke: recordCodingSmoke,
    prepareMerge: prepareCodingMerge,
    operations: [
      createCodingHumanMergeOperation(),
      createCodingWritePlanOperation(deps.database),
      createCodingPrFileOperation(deps.database),
      createCodingGithubReadOperation({
        readPrs: deps.readPrs,
        readRefStates: deps.readRefStates ?? createCodingRefReader(() => deps.prLedger.refFacts),
        listGithub:
          deps.listGithub ??
          (async (args) => ({ data: await listNeoGithub(args), at: new Date().toISOString() })),
      }),
    ],
    preferences: {
      watchedRepos: {
        label: { en: 'Watched repositories', 'zh-Hans': '关注的仓库' },
        valueLabels: {},
        scope: 'global',
        type: { kind: 'repositories' },
        default: [],
        ask: 'Which repositories should this instance watch?',
      },
      ...CODING_STAGE_PREFERENCES,
      provenance: {
        label: { en: 'Independent model provenance', 'zh-Hans': '独立模型来源' },
        valueLabels: {
          true: { en: 'Require independent model provenance', 'zh-Hans': '要求独立模型来源' },
          false: { en: 'Disable model provenance requirements', 'zh-Hans': '关闭模型来源要求' },
        },
        scope: 'repo',
        type: { kind: 'boolean' },
        default: true,
        ask: 'Require author model and harness provenance and a different reviewer model? Until answered, this is on without saving a preference.',
      },
      mergeBy: {
        label: { en: 'Merge executor', 'zh-Hans': '合并执行者' },
        valueLabels: {
          owner: { en: 'PR owner', 'zh-Hans': 'PR 负责人' },
          daemon: { en: 'Daemon', 'zh-Hans': '守护进程' },
        },
        scope: 'repo',
        type: { kind: 'enum', values: ['owner', 'daemon'] },
        default: 'owner',
        ask: 'Who should merge eligible PRs? Owner is the default; daemon squash-merges eligible PRs after fresh gates pass.',
      },
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
        ask: 'Which path globs or labels require human sign-off? Use label:human-merge for an explicit label; bare names also match labels.',
      },
    },
    prepareExecution: prepareCodingExecution,
    review: runCodingReview,
    todos: {
      ...todos,
      schema(db) {
        todos.schema(db);
        initializeCodingWatches(db, []);
      },
    },
    readFacts: todos.readFacts,
    judge: todos.judge,
    observeSessions: (sessions, now) => deps.prLedger.write('observeSessions', sessions, now),
    sweep: async (now) => {
      await deps.prLedger.write('observeSessions', await readClaudeOwners(), now);
      await deliverCodingPrEvents(deps.prEvents, [], prSweepDeps);
      const transitions = await reconcileCodingPrLedger(
        deps.prLedger,
        codingWatchedRepos(deps.database()) ?? deps.projectRepos(),
        deps.readLedgerRepo ?? readCodingLedgerRepo,
        now
      );
      await deliverCodingPrEvents(deps.prEvents, transitions, prSweepDeps);
      await deliverCodingHealth(
        deps.prLedger,
        codingWatchedRepos(deps.database()) ?? deps.projectRepos(),
        prSweepDeps.wake,
        now
      );
      await wakeCodingUnownedPrs(deps.prEvents, prSweepDeps.wake, now);
      await sweepCodingPrs(deps.prSweep, prSweepDeps, now);
      await mergeSweep(now);
    },
    stats: async (now) => ({
      'ready to merge >1h': (await deps.prLedger.read('list')).filter(
        (row) =>
          row.state === 'approved_green' &&
          row.closedAt === null &&
          row.stateSince < now - 60 * 60 * 1000
      ).length,
    }),
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
    workerBrief: (instruction, identity) =>
      withCodingWorkerProvenance(workerContext(instruction), identity),
    workGoal: (instruction, goal) => workerContext(withCodingWorkGoal(instruction, goal)),
  };
}
