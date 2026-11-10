import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { codingTodoPrReads } from './todo-prs.ts';
import { requireCodingLinkedIssue } from './linked-issue.ts';
import { homedir } from 'node:os';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import {
  buildGitHubLookupEnv,
  DEFAULT_GH_LOOKUP_TIMEOUT_MS,
  runGhJson,
} from '../../../github/gh-lookup-helpers.ts';
import type { ConnectorOutcome } from '../../../github/connectors/connector.ts';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from '../../../utils/script-utils.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { createCodingReviewThreadReader } from './connector-review-thread-reader.ts';
import { codingMergeGithubSchemas as schema } from './merge-operation.ts';
import type { CodingDaemonMergeFacts } from './daemon-merge-gates.ts';

const failed = (reason: string) => ({ reason: { ok: false as const, reason } });
const FilePage = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: schema.Head.pick({ headRefOid: true }).extend({
        baseRefOid: schema.Head.shape.headRefOid,
        files: z.object({
          nodes: z.array(z.object({ path: z.string() })),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});
const Response = z.tuple([
  schema.Pr.extend({
    baseRefOid: schema.Head.shape.headRefOid,
    mergeCommit: z.object({ oid: schema.Head.shape.headRefOid }).nullable(),
  }),
  schema.Reviews.min(1),
  schema.Checks,
  schema.Threads,
  z.array(z.array(z.object({ name: z.string() }))).min(1),
  z.array(FilePage).min(1),
]);
type Observed = z.infer<typeof Response>;
export async function readCodingRequiredChecks(
  url: string,
  spawn: SpawnFn
): Promise<ConnectorOutcome> {
  const proc = spawn(['gh', 'pr', 'checks', url, '--required', '--json', 'bucket,name,link'], {
    cwd: homedir(),
    env: buildGitHubLookupEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, DEFAULT_GH_LOOKUP_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
      collectWithMaxBuffer(proc.stderr, 16 * 1024),
      proc.exited,
    ]);
    if (timedOut || stdout.truncated || stderr.truncated)
      return { ok: false, error: 'Required checks lookup timed out or exceeded its output limit.' };
    if (
      code === 1 &&
      stdout.text === '' &&
      /^no (?:required )?checks reported on the '[^\r\n]+' branch$/.test(stderr.text.trim())
    )
      return { ok: true, data: [] };
    if (code !== 0)
      return { ok: false, error: stderr.text.trim() || `gh checks exited with code ${code}` };
    try {
      return { ok: true, data: JSON.parse(stdout.text) };
    } catch {
      return { ok: false, error: 'Required checks lookup returned invalid JSON.' };
    }
  } finally {
    clearTimeout(timer);
  }
}
const collect = async (db: Database, url: string, spawn: SpawnFn) => {
  const meta = parsePrUrl(url.toLowerCase())!;
  const gh = (args: string[]) => runGhJson(['gh', ...args], homedir(), spawn);
  const pull = await gh([
    'pr',
    'view',
    url,
    '--json',
    'url,body,state,headRefOid,baseRefOid,isDraft,mergeable,mergeStateStatus,author,changedFiles,files,labels,mergeCommit,closingIssuesReferences',
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
    readCodingRequiredChecks(url, spawn),
    createCodingReviewThreadReader(() => db, spawn)(url, homedir()),
    gh([
      'api',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      `repos/${meta.owner}/${meta.repo}/issues/${meta.number}/labels`,
    ]),
    gh([
      'api',
      'graphql',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      '-f',
      `owner=${meta.owner}`,
      '-f',
      `name=${meta.repo}`,
      '-F',
      `number=${meta.number}`,
      '-f',
      'query=query CodingMergeFiles($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid files(first:100,after:$endCursor){nodes{path} pageInfo{hasNextPage endCursor}}}}}',
    ]),
  ]);
  return {
    responses: responses.map((response) => (response.ok ? response.data : null)),
    failures: responses.flatMap((response, index) =>
      response.ok
        ? []
        : [
            `${['pull', 'reviews', 'required_checks', 'review_threads', 'labels', 'files'][index]}: ${response.error}`,
          ]
    ),
  };
};
const parse = ({ responses, failures }: Awaited<ReturnType<typeof collect>>, url: string) => {
  if (failures.length)
    return failed(
      `fresh_complete_merge_facts_required: ${failures.join('; ')}. Leave this PR unchanged until every required read succeeds.`
    );
  const parsed = Response.safeParse(responses);
  return parsed.success &&
    parsed.data[0].url.toLowerCase() === url.toLowerCase() &&
    parsed.data[3].headOid === parsed.data[0].headRefOid &&
    parsed.data[5].every((page, index, pages) => {
      const snapshot = page.data.repository.pullRequest;
      return (
        !page.errors?.length &&
        snapshot.headRefOid === parsed.data[0].headRefOid &&
        snapshot.baseRefOid === parsed.data[0].baseRefOid &&
        snapshot.files.pageInfo.hasNextPage === index < pages.length - 1 &&
        (!snapshot.files.pageInfo.hasNextPage || !!snapshot.files.pageInfo.endCursor)
      );
    })
    ? { value: parsed.data }
    : failed(
        'fresh_complete_merge_facts_required: Fresh, complete GitHub merge facts are required. Leave the PR unchanged until every required read succeeds.'
      );
};
const project = ([
  pr,
  reviews,
  checks,
  threads,
  labels,
  files,
]: Observed): CodingDaemonMergeFacts & {
  mergeCommit?: string | null;
  fileScopePaginated: boolean;
  passingCommitStatus: boolean;
} => {
  const paths = files.flatMap((page) =>
    page.data.repository.pullRequest.files.nodes.map((file) => file.path)
  );
  const complete = paths.length === pr.changedFiles && new Set(paths).size === paths.length;
  return {
    ok: true,
    head: pr.headRefOid,
    closingIssuesReferences: pr.closingIssuesReferences,
    state: pr.state,
    draft: pr.isDraft,
    mergeable: pr.mergeable,
    requiredCi: {
      head: pr.headRefOid,
      green: checks.every((check) => check.bucket === 'pass'),
      count: checks.length,
    },
    threads: { head: threads.headOid, unresolved: threads.unresolvedThreadUrls.length },
    reviews: reviews
      .flat()
      .flatMap((review) =>
        review.user ? [{ ...review.user, head: review.commit_id, state: review.state }] : []
      ),
    files: complete ? paths : null,
    fileScopePaginated: complete && pr.changedFiles > pr.files.length,
    passingCommitStatus: ['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus),
    labels: labels.flat().map((label) => label.name),
    mergeCommit: pr.mergeCommit?.oid ?? null,
  };
};
const read = (superpipe({})('coding.read-daemon-merge-facts') as PipelineAPI)
  .input(['db', 'url', 'spawn'])
  .pipe(
    (url: string) => {
      const meta = parsePrUrl(url.toLowerCase());
      return meta &&
        (meta.host === 'github.com' || meta.host === process.env.GH_HOST?.toLowerCase())
        ? { value: url }
        : failed(
            'unsupported_pr_url: Use a GitHub PR URL on github.com or the configured GH_HOST.'
          );
    },
    'url',
    'result:observed'
  )
  .pipe(collect, ['db', 'url', 'spawn'], 'responses')
  .pipe(parse, ['responses', 'url'], 'result:observed')
  .pipe(
    async (observed: Observed, url: string, spawn: SpawnFn) => {
      const result = await runGhJson(
        ['gh', 'pr', 'view', url, '--json', 'headRefOid,state,baseRefOid'],
        homedir(),
        spawn
      );
      if (!result.ok)
        return failed(
          `final_head_read_failed: ${result.error}. Leave this PR unchanged until its current head can be read.`
        );
      const head = schema.Head.extend({ baseRefOid: schema.Head.shape.headRefOid }).safeParse(
        result.data
      );
      return head.success &&
        head.data.headRefOid === observed[0].headRefOid &&
        head.data.baseRefOid === observed[0].baseRefOid &&
        head.data.state === observed[0].state
        ? { value: observed }
        : failed(
            'head_base_or_state_changed_during_read: The PR head, base or state changed during collection. Read the current PR again before merging.'
          );
    },
    ['observed', 'url', 'spawn'],
    'result:observed'
  )
  .pipe(project, 'observed', 'observed')
  .pipe(
    async (facts: ReturnType<typeof project>, db: Database, url: string) => {
      const mirrors = await gatewayFor(db).call(codingTodoPrReads, 'linkedIssues', url);
      return facts.ok
        ? { ...facts, linkedIssueReason: requireCodingLinkedIssue(facts, mirrors) }
        : facts;
    },
    ['observed', 'db', 'url'],
    'observed'
  )
  .endAsync('observed') as (
  db: Database,
  url: string,
  spawn: SpawnFn
) => Promise<ReturnType<typeof project>>;

export const readCodingDaemonMergeFacts = (db: Database, url: string, spawn = spawnProcess) =>
  read(db, url, spawn).catch(() => ({
    ok: false as const,
    reason:
      'merge_fact_read_failed: Merge facts could not be read. Leave the PR unchanged until a fresh read succeeds.',
  }));
