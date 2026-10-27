import { homedir } from 'node:os';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { NeoTodoSessionRepository } from '../../../../storage/repositories/neo-todo-session-repository.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';
import { defineOperation } from '../../../operations/registry.ts';
import { CodingAssignmentsRepository } from './assignments.ts';
import { createCodingReviewThreadReader } from './connector-review-thread-reader.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';
import type { CodingTodoPrRepository } from './todo-prs.ts';
import type { prepareCodingMerge } from './merge-gates.ts';
import type { runCodingReview } from './review.ts';

const Input = z
  .object({
    todoId: z.string().min(1),
    url: z
      .string()
      .refine((url) => !!parsePrUrl(url))
      .meta({ examples: ['https://github.com/example/repo/pull/1'] }),
  })
  .strict();
type Input = z.infer<typeof Input>;
const Head = z.object({ headRefOid: z.string().regex(/^[a-f\d]{40}$/i), state: z.string() });
const Pr = Head.extend({
  url: z.string(),
  body: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  author: z.object({ login: z.string() }),
  changedFiles: z.number().int().nonnegative(),
  files: z.array(z.object({ path: z.string() })),
  labels: z.array(z.object({ name: z.string() })),
});
const Reviews = z.array(
  z.array(
    z.object({
      state: z.string(),
      commit_id: z.string(),
      html_url: z.string().url(),
      user: z.object({ login: z.string(), type: z.string() }).nullable(),
    })
  )
);
const Checks = z.array(z.object({ bucket: z.string(), name: z.string().min(1), link: z.string() }));
const Threads = z.object({ headOid: z.string(), unresolvedThreadUrls: z.array(z.string()) });
type Deps = {
  db: Database;
  ledger: CodingPrLedgerRepository;
  todos: CodingTodoPrRepository;
  review: typeof runCodingReview;
  prepareMerge: typeof prepareCodingMerge;
};
type Result = Awaited<ReturnType<typeof prepareCodingMerge>>;
const refuse = (reason: string) => ({ reason: { accepted: false as const, reason } });

export function createCodingMergeOperation(deps: Deps) {
  const assignments = new CodingAssignmentsRepository(deps.db);
  const readThreads = createCodingReviewThreadReader(() => deps.db);
  const gh = (args: string[]) => runGhJson(['gh', ...args], homedir(), spawnProcess);
  const local = (input: Input, head: string) => ({
    assignments: assignments.read(input.todoId, input.url, head),
    write: new NeoTodoSessionRepository(deps.db).readCard(input.todoId)?.ref,
    facts: deps.ledger.stageFacts.read(input.url),
    policy: deps.ledger.policy(`${parsePrUrl(input.url)!.owner}/${parsePrUrl(input.url)!.repo}`),
    live: deps.db
      .prepare(
        "SELECT 1 FROM neo_todos t JOIN neo_asks a ON a.id=t.ask_id WHERE t.id=? AND t.state IN ('doing','blocked') AND a.status='open'"
      )
      .get(input.todoId),
    linked: deps.todos.urls(input.todoId).includes(githubUrlKey(input.url)),
  });
  const prepare = (superpipe({})('coding.admit-recorded-manual-merge') as PipelineAPI)
    .input('input')
    .pipe(
      (input: Input) => {
        const pr = parsePrUrl(input.url)!;
        return pr.host === 'github.com' || pr.host === (process.env.GH_HOST ?? '').toLowerCase()
          ? { value: input }
          : refuse('GitHub PR host is not allowed.');
      },
      'input',
      'result:result'
    )
    .pipe(
      async (input: Input) => {
        const pr = parsePrUrl(input.url)!;
        const [pull, reviews, checks, threads] = await Promise.all([
          gh([
            'pr',
            'view',
            input.url,
            '--json',
            'url,body,state,headRefOid,isDraft,mergeable,mergeStateStatus,author,changedFiles,files,labels',
          ]),
          gh([
            'api',
            '--hostname',
            pr.host,
            '--paginate',
            '--slurp',
            `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
          ]),
          gh(['pr', 'checks', input.url, '--required', '--json', 'bucket,name,link']),
          readThreads(input.url, homedir()),
        ]);
        const p = Pr.safeParse(pull.ok ? pull.data : null),
          r = Reviews.safeParse(reviews.ok ? reviews.data : null),
          c = Checks.safeParse(checks.ok ? checks.data : null),
          t = Threads.safeParse(threads.ok ? threads.data : null);
        return p.success &&
          r.success &&
          c.success &&
          t.success &&
          githubUrlKey(p.data.url) === githubUrlKey(input.url) &&
          t.data.headOid === p.data.headRefOid
          ? { value: { pr: p.data, reviews: r.data.flat(), checks: c.data, threads: t.data } }
          : refuse('Fresh complete GitHub merge facts are required.');
      },
      'input',
      'result:result'
    )
    .pipe(
      async (
        input: Input,
        observed: {
          pr: z.infer<typeof Pr>;
          reviews: z.infer<typeof Reviews>[number];
          checks: z.infer<typeof Checks>;
          threads: z.infer<typeof Threads>;
        }
      ): Promise<Result> => {
        const { pr, reviews, checks, threads } = observed,
          state = local(input, pr.headRefOid);
        const { review, qa } = state.assignments;
        if (
          !state.live ||
          !state.linked ||
          !review ||
          !qa?.ref ||
          !isDeepStrictEqual(review.write, state.write) ||
          !isDeepStrictEqual(qa.write, state.write) ||
          review.acceptanceContract !== qa.acceptanceContract
        )
          return {
            accepted: false,
            reason:
              'Current Review and Verify assignments on a live linked coding todo are required.',
          };
        if (
          !state.policy.mergePolicy ||
          (state.policy.mergePolicy === 'review_bot' && !state.policy.reviewBot) ||
          (review.bot ?? '').toLowerCase() !== (state.policy.reviewBot ?? '').toLowerCase()
        )
          return { accepted: false, reason: 'Resolve repository review policy before merging.' };
        const provenance = deps.ledger.reviewerPolicy(
          `${parsePrUrl(input.url)!.owner}/${parsePrUrl(input.url)!.repo}`,
          pr.body,
          review.actor ?? { kind: 'human', id: 'bot-route' }
        );
        if (!provenance.qualifies) return { accepted: false, reason: provenance.reason };
        const route = await deps.review(
          {
            head: pr.headRefOid,
            reviewBot: state.policy.reviewBot,
            reviews: reviews.map((r) => ({
              state: r.state,
              author: r.user,
              commit: { oid: r.commit_id },
            })),
          },
          { startReviewer: async () => review.ref!.id }
        );
        const latest = new Map<string, (typeof reviews)[number]>();
        for (const r of reviews)
          if (r.user && !['COMMENTED', 'PENDING'].includes(r.state))
            latest.set(r.user.login.toLowerCase(), r);
        const human = [...latest.values()].filter(
          (r) =>
            r.state === 'APPROVED' &&
            r.commit_id === pr.headRefOid &&
            r.user?.type === 'User' &&
            r.user.login.toLowerCase() !== pr.author.login.toLowerCase()
        );
        const signoff = state.policy.humanSignoff ?? [];
        const needsHuman =
          state.policy.mergePolicy === 'human' ||
          signoff.some((pattern) =>
            pattern.startsWith('label:')
              ? pr.labels.some((label) => posix.matchesGlob(label.name, pattern.slice(6)))
              : pr.files.some((file) => posix.matchesGlob(file.path, pattern))
          );
        return deps.prepareMerge(
          deps.todos.deliveryFacts,
          input.todoId,
          {
            url: input.url,
            head: pr.headRefOid,
            open:
              pr.state === 'OPEN' &&
              !pr.isDraft &&
              pr.mergeable === 'MERGEABLE' &&
              ['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus),
            requiredCiGreen: checks.every((check) => check.bucket === 'pass'),
            findingsResolved: threads.unresolvedThreadUrls.length === 0,
            humanSignoffSatisfied:
              pr.changedFiles === pr.files.length && (!needsHuman || human.length > 0),
            ciEvidence: checks.length
              ? checks.map((check) => check.link || `${input.url}/checks`)
              : [`${input.url}/checks`],
            reviewEvidence: [
              ...(route.kind === 'bot'
                ? reviews.filter(
                    (r) =>
                      r.user?.login.toLowerCase() === route.login.toLowerCase() &&
                      r.commit_id === route.head &&
                      r.state === 'APPROVED'
                  )
                : []),
              ...human,
            ].map((r) => r.html_url),
          },
          {
            reference: review.acceptanceContract,
            write: review.write,
            qa: qa.ref,
            reviewer: review.ref,
            bot: review.bot,
          },
          route,
          state.facts.filter((f) =>
            isDeepStrictEqual(f.actor, (f.stage === 'review' ? review : qa).actor)
          ),
          async () => {
            const fresh = await gh(['pr', 'view', input.url, '--json', 'headRefOid,state']);
            const head = Head.safeParse(fresh.ok ? fresh.data : null);
            return head.success &&
              head.data.state === 'OPEN' &&
              isDeepStrictEqual(state, local(input, pr.headRefOid))
              ? head.data.headRefOid
              : null;
          }
        );
      },
      ['input', 'result'],
      'result'
    )
    .endAsync('result') as (input: Input) => Promise<Result>;
  return defineOperation({
    name: 'neo.coding.merge.prepare',
    description:
      'Admit a linked coding PR for manual merge using persisted Review/Verify assignments, actual exact-head review, required CI, resolved findings and repository human sign-off. Re-reads the head, records gates and returns a SHA-pinned command; never merges or enables auto-merge.',
    inputSchema: Input,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), head: z.string(), command: z.array(z.string()) }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input) => prepare(input),
  });
}
