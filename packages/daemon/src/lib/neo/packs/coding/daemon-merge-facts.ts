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
const Response = z.tuple([
  schema.Pr.extend({ mergeCommit: z.object({ oid: schema.Head.shape.headRefOid }).nullable() }),
  schema.Reviews.min(1),
  schema.Checks,
  schema.Threads,
  z.array(z.array(z.object({ name: z.string() }))).min(1),
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
  ]);
  return {
    responses: responses.map((response) => (response.ok ? response.data : null)),
    failures: responses.flatMap((response, index) =>
      response.ok
        ? []
        : [
            `${['pull', 'reviews', 'required_checks', 'review_threads', 'labels'][index]}: ${response.error}`,
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
    parsed.data[3].headOid === parsed.data[0].headRefOid
    ? { value: parsed.data }
    : failed(
        'fresh_complete_merge_facts_required: Fresh, complete GitHub merge facts are required. Leave the PR unchanged until every required read succeeds.'
      );
};
const project = ([pr, reviews, checks, threads, labels]: Observed): CodingDaemonMergeFacts & {
  mergeCommit?: string | null;
} => ({
  ok: true,
  head: pr.headRefOid,
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
  files: pr.changedFiles === pr.files.length ? pr.files.map((file) => file.path) : null,
  labels: labels.flat().map((label) => label.name),
  mergeCommit: pr.mergeCommit?.oid ?? null,
});
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
        ['gh', 'pr', 'view', url, '--json', 'headRefOid,state'],
        homedir(),
        spawn
      );
      if (!result.ok)
        return failed(
          `final_head_read_failed: ${result.error}. Leave this PR unchanged until its current head can be read.`
        );
      const head = schema.Head.safeParse(result.data);
      return head.success &&
        head.data.headRefOid === observed[0].headRefOid &&
        head.data.state === observed[0].state
        ? { value: observed }
        : failed(
            'head_or_state_changed_during_read: The PR head or state changed during collection. Read the current PR again before merging.'
          );
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
  read(db, url, spawn).catch(() => ({
    ok: false as const,
    reason:
      'merge_fact_read_failed: Merge facts could not be read. Leave the PR unchanged until a fresh read succeeds.',
  }));
