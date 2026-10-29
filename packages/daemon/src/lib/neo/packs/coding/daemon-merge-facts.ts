import { homedir } from 'node:os';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { createCodingReviewThreadReader } from './connector-review-thread-reader.ts';
import { codingMergeGithubSchemas as schema } from './merge-operation.ts';
import type { CodingDaemonMergeFacts } from './daemon-merge-gates.ts';

const failed = (reason: string) => ({ reason: { ok: false as const, reason } });
const Response = z.tuple([
  schema.Pr.extend({ mergeCommit: z.object({ oid: schema.Head.shape.headRefOid }).nullable() }),
  schema.Reviews.min(1),
  schema.Checks,
  schema.Threads,
  z.array(z.array(z.object({ name: z.string() }))).min(1),
]);
type Observed = z.infer<typeof Response>;
const collect = async (db: Database, url: string, spawn: SpawnFn) => {
  const meta = parsePrUrl(url)!;
  const gh = (args: string[]) => runGhJson(['gh', ...args], homedir(), spawn);
  const pull = await gh([
    'pr',
    'view',
    url,
    '--json',
    'url,body,state,headRefOid,isDraft,mergeable,mergeStateStatus,author,changedFiles,files,labels,mergeCommit',
  ]);
  const responses = await Promise.all([
    pull,
    gh([
      'api',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      `repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/reviews`,
    ]),
    gh(['pr', 'checks', url, '--required', '--json', 'bucket,name,link']),
    createCodingReviewThreadReader(() => db, spawn)(url, homedir()),
    gh([
      'api',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      `repos/${meta.owner}/${meta.repo}/issues/${meta.number}/labels`,
    ]),
  ]);
  return responses.map((response) => (response.ok ? response.data : null));
};
const parse = (responses: unknown[], url: string) => {
  const parsed = Response.safeParse(responses);
  return parsed.success &&
    parsed.data[0].url.toLowerCase() === url.toLowerCase() &&
    parsed.data[3].headOid === parsed.data[0].headRefOid
    ? { value: parsed.data }
    : failed('fresh_complete_merge_facts_required');
};
const project = ([pr, reviews, checks, threads, labels]: Observed): CodingDaemonMergeFacts & {
  mergeCommit?: string | null;
} => ({
  ok: true,
  head: pr.headRefOid,
  state: pr.state,
  draft: pr.isDraft,
  mergeable: pr.mergeable,
  requiredCi: { head: pr.headRefOid, green: checks.every((check) => check.bucket === 'pass') },
  threads: { head: threads.headOid, unresolved: threads.unresolvedThreadUrls.length },
  reviews: reviews
    .flat()
    .flatMap((review) =>
      review.user ? [{ login: review.user.login, head: review.commit_id, state: review.state }] : []
    ),
  files: pr.changedFiles === pr.files.length ? pr.files.map((file) => file.path) : null,
  labels: labels.flat().map((label) => label.name),
  mergeCommit: pr.mergeCommit?.oid ?? null,
});
const read = (superpipe({})('coding.read-daemon-merge-facts') as PipelineAPI)
  .input(['db', 'url', 'spawn'])
  .pipe(
    (url: string) => {
      const meta = parsePrUrl(url);
      return meta &&
        (meta.host === 'github.com' || meta.host === process.env.GH_HOST?.toLowerCase())
        ? { value: url }
        : failed('unsupported_pr_url');
    },
    'url',
    'result:observed'
  )
  .pipe(collect, ['db', 'url', 'spawn'], 'responses')
  .pipe(parse, ['responses', 'url'], 'result:observed')
  .pipe(
    async (observed: Observed, url: string, spawn: SpawnFn) => {
      const result = await runGhJson(
        ['gh', 'pr', 'view', url, '--json', 'headRefOid,state'],
        homedir(),
        spawn
      );
      const head = schema.Head.safeParse(result.ok ? result.data : null);
      return head.success &&
        head.data.headRefOid === observed[0].headRefOid &&
        head.data.state === observed[0].state
        ? { value: observed }
        : failed('head_or_state_changed_during_read');
    },
    ['observed', 'url', 'spawn'],
    'result:observed'
  )
  .pipe(project, 'observed', 'observed')
  .endAsync('observed') as (
  db: Database,
  url: string,
  spawn: SpawnFn
) => Promise<ReturnType<typeof project>>;

export const readCodingDaemonMergeFacts = (db: Database, url: string, spawn = spawnProcess) =>
  read(db, url, spawn).catch(() => ({ ok: false as const, reason: 'merge_fact_read_failed' }));
