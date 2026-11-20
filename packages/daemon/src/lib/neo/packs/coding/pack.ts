import { createCodingIssueTracker, planCodingIssueHome } from './issue-tracker.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';
import { listPackPreferences } from '../../preference-operations.ts';
import { withCodingWorkerStartBrief } from './worker-worktree-brief.ts';
import { createCodingHumanMergeOperation } from './human-merge-operation.ts';
import { createCodingRetryMergeOperation } from './retry-merge-operation.ts';
import { createCodingDaemonMergeSweep } from './daemon-merge-sweep.ts';
import { CODING_ATTENTION_KINDS, type CodingAttend, scanCodingIdleOpenPrs } from './attention.ts';
import { checkCodingPrApproved } from './pr-approved.ts';
import { deliverCodingReviewAfterApproval } from './review-after-approval.ts';
import { checkCodingDeployed } from './deployed.ts';
import { createCodingLinkExists } from './link-exists.ts';
import { withCodingMergeContext } from './merge-context.ts';
import { codingWatchedRepos, initializeCodingWatches } from './watched-repos.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { createCodingPrFileOperation } from './pr-file-operation.ts';
import { runCodingReview } from './review.ts';
import { withCodingWorkGoal } from './work-goal.ts';
import { withCodingWorkerProvenance } from './worker-provenance.ts';
import { codingAskMatter, type NeoRefStateReader } from './ask-prs.ts';
import { createCodingRefReader } from './ref-reader.ts';
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
import { readCodingPostableReviews } from './review-comment.ts';
import type { CodingStageFact } from './stage-facts.ts';
import {
  type CodingPrSweepRepository,
  type CodingSweepDeps,
  codingFindingsText,
  sweepCodingPrs,
} from './pr-sweep.ts';
import { WORK_MESSAGE_MAX } from '../../../drivers/work-operations.ts';
import { type NeoWorkPrReader } from './work-prs.ts';
import { wakeCodingUnownedPrs } from './pr-unowned.ts';
import { recordCodingSmoke } from './delivery-facts.ts';
import { readCodingDaemonMergeFacts } from './daemon-merge-facts.ts';
import { decideCodingDaemonMerge } from './daemon-merge-gates.ts';
import { prepareCodingMerge } from './merge-gates.ts';
import { deliverCodingHealth } from './health-delivery.ts';
import { CODING_REVIEW_AFTER_PREFERENCE, CODING_STAGE_PREFERENCES } from './stage-preferences.ts';
import { decideCodingSessionTarget } from './session-target.ts';
import { CODING_WORK_KINDS, type CodingLines } from './stage-lines.ts';
import { createCodingReviewThreadReader } from './connector-review-thread-reader.ts';
import { createCodingQuotaReader, runCodingGh } from './ledger-quota.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe:
    'Software work in git repositories: pull requests, CI, review and merging. Check pr_approved {url} waits for saved-policy approval; pr_merged waits for merge. Multi-PR work uses one PR per todo, chained with after; name each opened PR with neo.todo.edit addUrls.',
  skill: 'coding-pack',
};

export function createCodingPack(deps: {
  database: () => Database;
  readPrs: NeoWorkPrReader;
  readRefStates?: NeoRefStateReader;
  todoPrs: CodingTodoPrRepository;
  prLedger: CodingPrLedgerRepository;
  prSweep: CodingPrSweepRepository;
  prEvents: CodingPrEventRepository;
  prSweepDeps: Omit<CodingSweepDeps, 'host'>;
  attend: CodingAttend;
  projectRepos: (projectId?: string) => string[];
  readLedgerRepo?: CodingLedgerRead;
  lines?: CodingLines;
  postReviewComments?: (
    read: () => Promise<readonly CodingStageFact[]>,
    posted: (fact: CodingStageFact, marker: string) => Promise<void>,
    held: (host: string, until: number) => Promise<void>
  ) => Promise<void>;
}): NeoPack & {
  readMergeFacts: typeof readCodingDaemonMergeFacts;
  decideMerge: typeof decideCodingDaemonMerge;
  recordSmoke: typeof recordCodingSmoke;
  prepareMerge: typeof prepareCodingMerge;
  review: typeof runCodingReview;
} {
  const workerContext = (text: string) =>
    withCodingMergeContext(text, deps.prLedger.policyContext(text, deps.projectRepos()));
  const notificationContext = async (text: string) =>
    withCodingMergeContext(text, await deps.prLedger.policyContextCurrent(text));
  const prSweepDeps: CodingSweepDeps = {
    host: process.env.GH_HOST ?? 'github.com',
    tell: async (ref, key, text, pr, findings) => {
      const context = (await notificationContext(text)).slice(text.length);
      return deps.prSweepDeps.tell(
        ref,
        key,
        `${text}${codingFindingsText(findings, WORK_MESSAGE_MAX - text.length - context.length)}${context}`,
        pr && (await deps.todoPrs.readHolder(pr, ref))
      );
    },
    human: async (key, text) => (await deps.prSweepDeps.human?.(key, text)) ?? false,
    wake: async (key, text) => deps.prSweepDeps.wake(key, await notificationContext(text)),
  };
  const attend: CodingAttend = async (event) =>
    deps.attend({
      ...event,
      facts: { text: await notificationContext(String(event.facts.text)) },
    });
  const mergeSweep = createCodingDaemonMergeSweep(deps.database, deps.prLedger, deps.prEvents, {
    ...prSweepDeps,
    attend,
  });
  const refreshThreads = createCodingReviewThreadReader(deps.database);
  const threadQuota = createCodingQuotaReader(runCodingGh);
  const todos = createCodingTodoPack(
    deps.todoPrs,
    deps.readPrs,
    (url) => deps.prLedger.stateOf(url),
    deps.readRefStates ?? createCodingRefReader(() => deps.prLedger.refFacts),
    (url) => checkCodingPrApproved(url, (repo) => deps.prLedger.policy(repo)),
    (repo, sha) => checkCodingDeployed(repo, sha, deps.prLedger.ancestryFacts)
  );
  const trackerOwners = () => new NeoAskTodoRepository(deps.database());
  return {
    ...CODING_PACK_BRIEF,
    readMergeFacts: readCodingDaemonMergeFacts,
    decideMerge: decideCodingDaemonMerge,
    recordSmoke: recordCodingSmoke,
    prepareMerge: prepareCodingMerge,
    operations: [
      createCodingHumanMergeOperation(undefined, mergeSweep.invalidate),
      createCodingRetryMergeOperation(
        deps.database,
        deps.prLedger,
        undefined,
        mergeSweep.invalidate
      ),
      createCodingPrFileOperation(deps.database),
    ],
    linkExists: createCodingLinkExists(),
    tracker: createCodingIssueTracker({
      repositories: (askId, todoId) => deps.todoPrs.trackerRepositories(askId, todoId),
      createdAt: (marker) => {
        const [, kind, id] = marker.split(':');
        if (!id) return null;
        return (
          (kind === 'ask' ? trackerOwners().getAsk(id) : trackerOwners().getTodo(id))?.createdAt ??
          null
        );
      },
      enabled: (repo) =>
        listPackPreferences(deps.database(), 'coding').find(
          (preference) =>
            preference.key === 'mirror_issues' &&
            preference.scope.kind === 'repo' &&
            planCodingIssueHome([{ repo: preference.scope.key }]) === repo
        )?.value === true,
    }),
    workKinds: CODING_WORK_KINDS,
    preferences: {
      mirror_issues: {
        label: { en: 'Mirror plans to GitHub Issues', 'zh-Hans': '把计划同步到 GitHub Issues' },
        valueLabels: {},
        valueDescriptions: {
          true: { en: 'Create issues for plans and todos.', 'zh-Hans': '为计划和待办创建问题。' },
          false: { en: 'Keep plans in Neo.', 'zh-Hans': '计划只保存在 Neo。' },
        },
        scope: 'repo',
        type: { kind: 'boolean' },
        default: false,
        question: {
          en: 'Mirror plans to GitHub Issues?',
          'zh-Hans': '将计划同步到 GitHub Issues 吗？',
        },
        ask: 'Mirror plans and their todos to GitHub Issues in this private repository?',
      },
      watchedRepos: {
        label: { en: 'Watched repositories', 'zh-Hans': '关注的仓库' },
        valueLabels: {},
        valueDescriptions: {},
        scope: 'global',
        type: { kind: 'repositories' },
        default: [],
        question: { en: 'Which repositories should be watched?', 'zh-Hans': '要关注哪些仓库？' },
        ask: 'Which repositories should this instance watch?',
      },
      ...CODING_STAGE_PREFERENCES,
      'review.after': CODING_REVIEW_AFTER_PREFERENCE,
      provenance: {
        label: { en: 'Independent model provenance', 'zh-Hans': '独立模型来源' },
        valueLabels: {
          true: { en: 'Require independent model provenance', 'zh-Hans': '要求独立模型来源' },
          false: { en: 'Disable model provenance requirements', 'zh-Hans': '关闭模型来源要求' },
        },
        valueDescriptions: {
          true: {
            en: 'Require the author model and harness, and a different reviewer model.',
            'zh-Hans': '要求记录作者模型和工具，并由不同模型审查。',
          },
          false: { en: 'Do not require independent provenance.', 'zh-Hans': '不要求独立来源。' },
        },
        scope: 'repo',
        type: { kind: 'boolean' },
        default: true,
        question: {
          en: 'Require independent model provenance?',
          'zh-Hans': '要求独立模型来源吗？',
        },
        ask: 'Require author model and harness provenance and a different reviewer model? Until answered, this is on without saving a preference.',
      },
      crossModelReview: {
        label: { en: 'Cross-model review', 'zh-Hans': '跨模型审查' },
        valueLabels: {
          true: { en: 'Require a review by a different model', 'zh-Hans': '要求不同模型审查' },
          false: { en: 'No cross-model review gate', 'zh-Hans': '不要求跨模型审查' },
        },
        valueDescriptions: {
          true: {
            en: 'Wait for a different model to review the latest commit.',
            'zh-Hans': '等待不同模型审查最新提交。',
          },
          false: { en: 'Do not require a different model.', 'zh-Hans': '不要求不同模型审查。' },
        },
        scope: 'repo',
        type: { kind: 'boolean' },
        default: false,
        question: {
          en: 'Require a review by a different model?',
          'zh-Hans': '要求不同模型审查吗？',
        },
        ask: 'Hold bot-approved green PRs until a model different from the Agent line has passed a Review on the head?',
      },
      allowNoChecksMerge: {
        label: { en: 'Allow merging without checks', 'zh-Hans': '允许无检查合并' },
        valueLabels: {
          true: { en: 'Allow for this repository', 'zh-Hans': '允许本仓库' },
          false: { en: 'Hand off to the human', 'zh-Hans': '交给人类合并' },
        },
        valueDescriptions: {
          true: {
            en: 'Allow a merge with no required checks or review bot.',
            'zh-Hans': '允许没有必需检查或审查机器人的合并。',
          },
          false: {
            en: 'Ask the human to merge when no checks or review bot are required.',
            'zh-Hans': '没有必需检查或审查机器人时交给人类合并。',
          },
        },
        scope: 'repo',
        type: { kind: 'boolean' },
        default: false,
        question: {
          en: 'Allow merging without required checks?',
          'zh-Hans': '允许无必需检查合并吗？',
        },
        ask: 'Allow zero-required-check merges without a review bot in this repository? Only an explicit repository setting enables this; all other merge gates still apply.',
      },
      mergeBy: {
        label: { en: 'Merge executor', 'zh-Hans': '合并执行者' },
        valueLabels: {
          owner: { en: 'PR owner', 'zh-Hans': 'PR 负责人' },
          daemon: { en: 'Daemon', 'zh-Hans': '守护进程' },
        },
        valueDescriptions: {
          owner: { en: 'The pull request owner merges.', 'zh-Hans': '由拉取请求负责人合并。' },
          daemon: {
            en: 'The daemon merges after the gates pass.',
            'zh-Hans': '检查通过后由守护进程合并。',
          },
        },
        scope: 'repo',
        type: { kind: 'enum', values: ['owner', 'daemon'] },
        default: 'owner',
        question: {
          en: 'Who should merge eligible pull requests?',
          'zh-Hans': '谁来合并符合条件的拉取请求？',
        },
        ask: 'Who should merge eligible PRs? Owner is the default; daemon squash-merges eligible PRs after fresh gates pass.',
      },
      mergePolicy: {
        label: { en: 'Merge policy', 'zh-Hans': '合并规则' },
        valueLabels: {
          review_bot: { en: 'CI and review bot approval', 'zh-Hans': 'CI 通过且审查机器人批准' },
          ci_only: { en: 'CI passes', 'zh-Hans': 'CI 通过' },
          human: { en: 'Human approval', 'zh-Hans': '人工批准' },
        },
        valueDescriptions: {
          review_bot: {
            en: 'Wait for checks and the configured review bot.',
            'zh-Hans': '等待检查通过和指定审查机器人批准。',
          },
          ci_only: { en: 'Wait for the required checks.', 'zh-Hans': '等待必需检查通过。' },
          human: { en: 'Wait for human approval.', 'zh-Hans': '等待人工批准。' },
        },
        scope: 'repo',
        type: { kind: 'enum', values: ['review_bot', 'ci_only', 'human'] },
        default: 'human',
        question: { en: 'How are pull requests reviewed?', 'zh-Hans': '如何审查拉取请求？' },
        ask: 'How are pull requests reviewed in this repository?',
      },
      reviewBot: {
        label: { en: 'Review bot', 'zh-Hans': '审查机器人' },
        valueLabels: {},
        valueDescriptions: {},
        scope: 'repo',
        type: { kind: 'login' },
        default: 'hyperneo-ai-test',
        question: { en: 'Which review bot must approve?', 'zh-Hans': '哪个审查机器人必须批准？' },
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
        valueDescriptions: {
          '[]': {
            en: 'No additional paths or labels require approval.',
            'zh-Hans': '没有额外需要批准的路径或标签。',
          },
        },
        scope: 'repo',
        type: { kind: 'globs' },
        default: [],
        question: {
          en: 'Which paths or labels need human approval?',
          'zh-Hans': '哪些路径或标签需要人工批准？',
        },
        ask: 'Which path globs or labels require human sign-off? Use label:human-merge for an explicit label; bare names also match labels.',
      },
    },
    preparationPerRoundFields: ['head'],
    prepareExecution: prepareCodingExecution,
    workerTarget: (todo, target) =>
      decideCodingSessionTarget(deps.database(), todo, target, deps.lines),
    matter: (ask) => codingAskMatter(ask, ask.projectId ? deps.projectRepos(ask.projectId) : []),
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
    attention: { kinds: CODING_ATTENTION_KINDS, scan: scanCodingIdleOpenPrs(deps.todoPrs) },
    sweep: async (now) => {
      const transitions = await reconcileCodingPrLedger(
        deps.prLedger,
        codingWatchedRepos(deps.database()) ?? deps.projectRepos(),
        deps.readLedgerRepo ?? readCodingLedgerRepo,
        now,
        deps.readLedgerRepo
          ? undefined
          : async (url, cwd, quota) => {
              const allowed = await threadQuota.preflight('graphql', quota);
              return allowed.ok ? refreshThreads(url, cwd) : allowed;
            }
      );
      if (deps.postReviewComments)
        await deps.postReviewComments(
          () => readCodingPostableReviews(deps.database(), deps.prLedger, now),
          (fact, marker) => deps.prLedger.write('recordPostedReview', fact.url, marker),
          (host, until) => deps.prLedger.write('recordReviewCommentHold', host, until)
        );
      await mergeSweep(now);
      await deliverCodingPrEvents(deps.prEvents, transitions, prSweepDeps);
      await deliverCodingReviewAfterApproval(deps.database(), prSweepDeps.host, attend);
      await deliverCodingHealth(
        deps.prLedger,
        codingWatchedRepos(deps.database()) ?? deps.projectRepos(),
        deps.attend,
        now
      );
      await wakeCodingUnownedPrs(deps.prEvents, attend, now);
      await sweepCodingPrs(deps.prSweep, { ...prSweepDeps, attend }, now);
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
    workerStartBrief: withCodingWorkerStartBrief,
    workerBrief: (instruction, identity) =>
      withCodingWorkerProvenance(workerContext(instruction), identity),
    workGoal: (instruction, goal) => workerContext(withCodingWorkGoal(instruction, goal)),
  };
}
