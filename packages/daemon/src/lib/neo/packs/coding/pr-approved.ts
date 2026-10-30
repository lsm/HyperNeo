import superpipe, { type PipelineAPI } from 'superpipe';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { NeoTodoCheckResult } from '../../pack-contract.ts';
import type { CodingMergePolicy } from './pr-ledger.ts';
import { runCodingGh, type LedgerQuotaRun } from './ledger-quota.ts';
import { codingMergeGithubSchemas as schema } from './merge-operation.ts';
import { codingReviewOnHead } from './review.ts';

type ReadPolicy = (repo: string) => CodingMergePolicy;
type Subject = {
  url: string;
  repo: string;
  host: string;
  reviews: string;
  policy: CodingMergePolicy;
};
type Head = { headRefOid: string; state: string };
type Gate<T> = { value: T } | { reason: NeoTodoCheckResult };
const pending = (): { reason: NeoTodoCheckResult } => ({ reason: { done: false, evidence: null } });
export const codingApprovalUrl = (url: unknown) => {
  const pr = typeof url === 'string' ? parsePrUrl(url) : null;
  return pr &&
    Number.isSafeInteger(Number(pr.number)) &&
    Number(pr.number) > 0 &&
    [process.env.GH_HOST?.toLowerCase(), 'github.com'].includes(pr.host.toLowerCase())
    ? pr
    : null;
};
const plan = (url: string, readPolicy: ReadPolicy): Gate<Subject> => {
  const pr = codingApprovalUrl(url);
  if (!pr) return pending();
  const repo = `${pr.owner}/${pr.repo}`.toLowerCase(),
    policy = { ...readPolicy(repo) };
  if (
    policy.mergePolicy !== 'ci_only' &&
    !(policy.mergePolicy === 'review_bot' && policy.reviewBot)
  )
    return pending();
  return {
    value: {
      url,
      repo,
      host: pr.host,
      reviews: `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
      policy,
    },
  };
};
const readHead = async (subject: Subject, run: LedgerQuotaRun): Promise<Gate<Head>> => {
  const result = await run(
    ['gh', 'pr', 'view', subject.url, '--json', 'headRefOid,state'],
    'graphql'
  );
  const head = schema.Head.safeParse(result.ok ? result.data : null);
  return head.success ? { value: head.data } : pending();
};
const readDecision = async (
  head: Head,
  subject: Subject,
  run: LedgerQuotaRun
): Promise<Gate<Head>> => {
  if (subject.policy.mergePolicy === 'ci_only') {
    const result = await run(
      ['gh', 'pr', 'checks', subject.url, '--required', '--json', 'bucket,name,link'],
      'graphql'
    );
    const checks = schema.Checks.safeParse(result.ok ? result.data : null);
    return checks.success &&
      checks.data.length > 0 &&
      checks.data.every((check) => check.bucket === 'pass')
      ? { value: head }
      : pending();
  }
  const result = await run(
    ['gh', 'api', '--hostname', subject.host, '--paginate', '--slurp', subject.reviews],
    'core'
  );
  const reviews = schema.Reviews.min(1).safeParse(result.ok ? result.data : null);
  if (!reviews.success) return pending();
  const latest = codingReviewOnHead({
    head: head.headRefOid,
    reviewBot: subject.policy.reviewBot,
    reviews: reviews.data.flat().map((review) => ({
      state: review.state,
      commit: { oid: review.commit_id },
      author: review.user ? { login: review.user.login } : null,
    })),
  });
  return latest?.state === 'APPROVED' ? { value: head } : pending();
};
const confirm = async (
  head: Head,
  subject: Subject,
  readPolicy: ReadPolicy,
  run: LedgerQuotaRun
): Promise<Gate<Head>> => {
  const current = await readHead(subject, run),
    policy = readPolicy(subject.repo);
  return 'value' in current &&
    current.value.headRefOid === head.headRefOid &&
    policy.mergePolicy === subject.policy.mergePolicy &&
    policy.reviewBot === subject.policy.reviewBot
    ? { value: head }
    : pending();
};
const check = (superpipe({})('coding.check-pr-approved') as PipelineAPI)
  .input(['url', 'readPolicy', 'run'])
  .pipe(plan, ['url', 'readPolicy'], 'result:result')
  .pipe((subject: Subject) => subject, 'result', 'subject')
  .pipe(readHead, ['subject', 'run'], 'result:result')
  .pipe(readDecision, ['result', 'subject', 'run'], 'result:result')
  .pipe(confirm, ['result', 'subject', 'readPolicy', 'run'], 'result:result')
  .pipe(
    (head: Head, subject: Subject): NeoTodoCheckResult => ({
      done: true,
      evidence: `${subject.url} approved on ${head.headRefOid} (${subject.policy.mergePolicy}${subject.policy.mergePolicy === 'review_bot' ? `: ${subject.policy.reviewBot}` : ''}).`,
    }),
    ['result', 'subject'],
    'result'
  )
  .endAsync('result') as (
  url: string,
  readPolicy: ReadPolicy,
  run: LedgerQuotaRun
) => Promise<NeoTodoCheckResult>;

export const checkCodingPrApproved = (url: string, readPolicy: ReadPolicy, run = runCodingGh) =>
  check(url, readPolicy, run).catch(() => ({ done: false, evidence: null }));
