import { type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { githubGraphqlArgs, githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

export type NeoWorkPrReader = (urls: readonly string[]) => Promise<NeoWorkPr[] | null>;

export const NEO_WORK_PR_READ_MS = 2 * 60_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const GhPrSchema = z.object({
  url: z.string(),
  createdAt: z.string().optional(),
  mergedAt: z.string().nullish(),
  closedAt: z.string().nullish(),
  title: z.string().optional(),
  body: z.string().optional(),
  closingIssuesReferences: z.array(z.object({ number: z.number() })).optional(),
  headRefName: z.string().optional(),
  mergeStateStatus: z.string().optional(),
  baseRefName: z.string().optional(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefOid: z.string(),
  reviews: z.array(
    z.object({
      state: z.string(),
      commit: z.object({ oid: z.string() }).nullish(),
      author: z.object({ login: z.string() }).nullish(),
    })
  ),
  statusCheckRollup: z.array(
    z.object({
      status: z.string().nullish(),
      conclusion: z.string().nullish(),
      state: z.string().nullish(),
    })
  ),
});
type GhCheck = z.infer<typeof GhPrSchema>['statusCheckRollup'][number];

export function extractNeoWorkPrUrls(
  report: string | null,
  tracked: readonly { url: string }[] = []
): string[] {
  const urls = new Map<string, string>();
  for (const url of [...tracked.map((pr) => pr.url), ...(report?.match(PR_URL) ?? [])])
    if (!urls.has(githubUrlKey(url))) urls.set(githubUrlKey(url), url);
  return [...urls.values()].slice(0, 8);
}

function checkResult(check: GhCheck): NeoWorkPr['checks'] {
  if (check.state)
    return check.state === 'SUCCESS'
      ? 'passing'
      : ['PENDING', 'EXPECTED'].includes(check.state)
        ? 'pending'
        : 'failing';
  if (check.status !== 'COMPLETED') return 'pending';
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? '') ? 'passing' : 'failing';
}

export function summarizeNeoWorkPr(raw: unknown): NeoWorkPr | null {
  const parsed = GhPrSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { url, state, headRefOid, reviews, statusCheckRollup, createdAt, title, headRefName } =
    parsed.data;
  const refs = [
    ...new Set([
      ...neoTextRefs(`${title ?? ''}\n${parsed.data.body ?? ''}`),
      ...(parsed.data.closingIssuesReferences ?? []).map((issue) => issue.number),
    ]),
  ];
  const results = statusCheckRollup.map(checkResult);
  const checks = results.includes('pending')
    ? 'pending'
    : results.includes('failing')
      ? 'failing'
      : results.length
        ? 'passing'
        : 'none';
  const verdict = reviews
    .filter((item) => item.commit?.oid === headRefOid)
    .map((item) => item.state)
    .filter((item) => item === 'APPROVED' || item === 'CHANGES_REQUESTED')
    .at(-1);
  const review = verdict === 'APPROVED' ? 'approved' : verdict ? 'changes_requested' : 'none';
  const created = Date.parse(createdAt ?? '');
  const merged = Date.parse(parsed.data.mergedAt ?? '');
  const closed = Date.parse(parsed.data.closedAt ?? '');
  return {
    url,
    state,
    checks,
    review,
    ...(Number.isFinite(created) ? { createdAt: created } : {}),
    ...(Number.isFinite(merged) ? { mergedAt: merged } : {}),
    ...(Number.isFinite(closed) ? { closedAt: closed } : {}),
    ...(title ? { title } : {}),
    ...(headRefName ? { branch: headRefName } : {}),
    head: headRefOid,
    ...(refs.length ? { refs } : {}),
  };
}

export function neoTextRefs(text: string): number[] {
  return [...text.matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)\b/g)].map((match) => Number(match[1]));
}

type StoredPrs = {
  prs: readonly NeoWorkPr[];
  readAt: number;
  readOkAt: number;
};

export function shouldReadNeoWorkPrs(
  stored: StoredPrs | null,
  urls: readonly string[],
  now: number
): boolean {
  if (!urls.length) return false;
  const same = (url: string) => (pr: { url: string }) => githubUrlKey(pr.url) === githubUrlKey(url);
  if (!stored || urls.some((url) => !stored.prs.some(same(url)))) return true;
  return stored.prs.some((pr) => pr.state === 'OPEN') && now - stored.readAt >= NEO_WORK_PR_READ_MS;
}

type BranchRule = {
  type: string;
  parameters?: {
    required_approving_review_count?: number | null;
    required_review_thread_resolution?: boolean | null;
  } | null;
};
type PrDetail = { commits: { oid: string; signed: boolean }[]; unresolved: number };

const RULES_MS = 10 * 60_000;
const RULES_RETRY_MS = 60_000;
const githubPr = (url: string) => {
  const pr = parsePrUrl(url);
  return pr?.host === 'github.com' ? pr : null;
};
const rulesCache = new Map<string, { at: number; rules: readonly BranchRule[] | null }>();
const RulesSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({
        required_approving_review_count: z.number().nullish(),
        required_review_thread_resolution: z.boolean().nullish(),
      })
      .passthrough()
      .nullish(),
  })
);
const DetailSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        commits: z.object({
          nodes: z.array(
            z.object({
              commit: z.object({
                oid: z.string(),
                signature: z.object({ isValid: z.boolean() }).nullable(),
              }),
            })
          ),
        }),
        reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) }),
      }),
    }),
  }),
});
const DETAIL_QUERY =
  'query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){commits(last:50){nodes{commit{oid signature{isValid}}}} reviewThreads(first:100){nodes{isResolved}}}}}';

type RequiredCheck = { context: string; integrationId: number | null };

function requiredChecks(rules: readonly BranchRule[]): RequiredCheck[] {
  return rules
    .filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => {
      const parameters = rule.parameters as Record<string, unknown> | null | undefined;
      const checks = parameters?.required_status_checks;
      if (Array.isArray(checks))
        return checks.flatMap((check) => {
          if (typeof check === 'string') return [{ context: check, integrationId: null }];
          if (check && typeof check === 'object' && typeof check.context === 'string')
            return [
              {
                context: check.context,
                integrationId:
                  typeof check.integration_id === 'number' ? check.integration_id : null,
              },
            ];
          return [];
        });
      const contexts = parameters?.contexts;
      return Array.isArray(contexts)
        ? contexts.flatMap((context) =>
            typeof context === 'string' ? [{ context, integrationId: null }] : []
          )
        : [];
    });
}

export function wantsNeoWorkPrBlockers(pr: NeoWorkPr, base: string | undefined): boolean {
  return !!base && pr.state === 'OPEN' && pr.checks !== 'pending';
}

export function countNeoWorkPrApprovals(
  reviews: readonly { state: string; author?: { login: string } | null }[]
): number {
  const latest = new Map<string, string>();
  for (const review of reviews)
    if (review.author && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
      latest.set(review.author.login, review.state);
  return [...latest.values()].filter((state) => state === 'APPROVED').length;
}

export function planNeoWorkPrBlockers(input: {
  base: string;
  mergeState?: string;
  approvals: number;
  rules: readonly BranchRule[];
  detail: PrDetail | null;
}): string[] {
  if (['CLEAN', 'HAS_HOOKS'].includes(input.mergeState ?? '')) return [];
  const pull = input.rules.find((rule) => rule.type === 'pull_request')?.parameters;
  const unsigned = input.detail?.commits.filter((commit) => !commit.signed) ?? [];
  const unresolved = input.detail?.unresolved ?? 0;
  const approvals = pull?.required_approving_review_count ?? 0;
  return [
    ...(input.rules.some((rule) => rule.type === 'required_signatures') && unsigned.length
      ? [
          `unsigned commits: ${input.base} requires signed commits (${unsigned
            .slice(0, 3)
            .map((commit) => commit.oid.slice(0, 7))
            .join(', ')})`,
        ]
      : []),
    ...(pull?.required_review_thread_resolution && unresolved
      ? [`${unresolved} unresolved review thread${unresolved === 1 ? '' : 's'}`]
      : []),
    ...(input.approvals < approvals
      ? [`needs ${approvals} approving review${approvals === 1 ? '' : 's'}, has ${input.approvals}`]
      : []),
    ...(input.mergeState === 'BEHIND' ? [`behind ${input.base}`] : []),
    ...(input.mergeState === 'DIRTY' ? [`merge conflicts with ${input.base}`] : []),
  ];
}

function gh(args: string[], spawnImpl: SpawnFn, resourceHint: 'core' | 'graphql') {
  return runGhJson(args, homedir(), spawnImpl, { resourceHint });
}

const CheckRunsSchema = z.array(
  z.object({
    check_runs: z.array(
      z.object({
        name: z.string().nullish(),
        status: z.string().nullish(),
        conclusion: z.string().nullish(),
        app: z.object({ id: z.number().nullish() }).nullish(),
      })
    ),
  })
);
const CombinedStatusSchema = z.array(
  z.object({
    statuses: z.array(
      z.object({
        state: z.string(),
        context: z.string().nullish(),
        creator: z.object({ id: z.number().nullish() }).nullish(),
      })
    ),
  })
);

const REST_PAGE_SIZE = 100;

async function readCheckRollup(
  url: string,
  raw: Record<string, unknown>,
  spawnImpl: SpawnFn
): Promise<GhCheck[] | null> {
  if (raw.state !== 'OPEN') return [];
  const meta = parsePrUrl(url);
  if (!meta || typeof raw.headRefOid !== 'string' || !raw.headRefOid) return null;
  const base = `repos/${meta.owner}/${meta.repo}/commits/${raw.headRefOid}`;
  const rollup: GhCheck[] = [];
  const runs = await gh(
    [
      'gh',
      'api',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      `${base}/check-runs?per_page=${REST_PAGE_SIZE}`,
    ],
    spawnImpl,
    'core'
  );
  const parsedRuns = runs.ok ? CheckRunsSchema.safeParse(runs.data) : null;
  if (parsedRuns?.success) {
    for (const page of parsedRuns.data)
      for (const run of page.check_runs)
        rollup.push({
          status: run.status ? run.status.toUpperCase() : null,
          conclusion: run.conclusion ? run.conclusion.toUpperCase() : null,
        });
  }
  const statuses = await gh(
    [
      'gh',
      'api',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      `${base}/status?per_page=${REST_PAGE_SIZE}`,
    ],
    spawnImpl,
    'core'
  );
  const parsedStatuses = statuses.ok ? CombinedStatusSchema.safeParse(statuses.data) : null;
  if (parsedStatuses?.success)
    for (const page of parsedStatuses.data)
      for (const status of page.statuses) rollup.push({ state: status.state.toUpperCase() });
  if (!parsedRuns?.success || !parsedStatuses?.success) return null;
  const covered = new Map<string, Set<number | null>>();
  const cover = (context: string, provider: number | null | undefined) => {
    const providers = covered.get(context.toUpperCase()) ?? new Set<number | null>();
    providers.add(provider ?? null);
    covered.set(context.toUpperCase(), providers);
  };
  for (const page of parsedRuns?.data ?? [])
    for (const run of page.check_runs) if (run.name) cover(run.name, run.app?.id ?? null);
  for (const page of parsedStatuses?.data ?? [])
    for (const status of page.statuses)
      if (status.context) cover(status.context, status.creator?.id ?? null);
  if (typeof raw.baseRefName === 'string' && raw.baseRefName) {
    const rules = await fetchBranchRules(
      `${meta.owner}/${meta.repo}`,
      raw.baseRefName,
      meta.host,
      spawnImpl
    );
    if (rules === null) return null;
    for (const check of requiredChecks(rules)) {
      const providers = covered.get(check.context.toUpperCase());
      const satisfied =
        check.integrationId === null
          ? providers !== undefined
          : (providers?.has(check.integrationId) ?? false);
      if (!satisfied) rollup.push({ state: 'EXPECTED' });
    }
  }
  return rollup;
}

async function fetchBranchRules(
  repo: string,
  base: string,
  host: string,
  spawnImpl: SpawnFn
): Promise<readonly BranchRule[] | null> {
  const key = `${host}/${repo}:${base}`;
  const cached = rulesCache.get(key);
  if (cached && Date.now() - cached.at < (cached.rules ? RULES_MS : RULES_RETRY_MS))
    return cached.rules;
  const outcome = await gh(
    ['gh', 'api', '--hostname', host, `repos/${repo}/rules/branches/${encodeURIComponent(base)}`],
    spawnImpl,
    'core'
  );
  const parsed = outcome.ok ? RulesSchema.safeParse(outcome.data) : null;
  const rules = parsed?.success ? parsed.data : null;
  rulesCache.set(key, { at: Date.now(), rules });
  return rules;
}

async function readBranchRules(repo: string, base: string, spawnImpl: SpawnFn) {
  return (await fetchBranchRules(repo, base, 'github.com', spawnImpl)) ?? [];
}

async function readPrDetail(url: string, spawnImpl: SpawnFn): Promise<PrDetail | null> {
  const pr = githubPr(url);
  if (!pr) return null;
  const outcome = await gh(githubGraphqlArgs(DETAIL_QUERY, pr), spawnImpl, 'graphql');
  const parsed = outcome.ok ? DetailSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) return null;
  const pull = parsed.data.data.repository.pullRequest;
  return {
    commits: pull.commits.nodes.map(({ commit }) => ({
      oid: commit.oid,
      signed: commit.signature?.isValid === true,
    })),
    unresolved: pull.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
  };
}

const readGithubPr = (superpipe({})('neo-work-pr-read') as PipelineAPI)
  .input(['url', 'spawnImpl'])
  .pipe(
    async (url: string, spawnImpl: SpawnFn) => {
      const outcome = await gh(
        [
          'gh',
          'pr',
          'view',
          url,
          '--json',
          'url,state,headRefOid,reviews,mergeStateStatus,baseRefName,createdAt,mergedAt,closedAt,title,headRefName,body,closingIssuesReferences',
        ],
        spawnImpl,
        'graphql'
      );
      if (!outcome.ok) return { raw: null };
      const raw = { ...(outcome.data as Record<string, unknown>) };
      const rollup = await readCheckRollup(url, raw, spawnImpl);
      if (rollup === null) return { raw: null };
      raw.statusCheckRollup = rollup;
      return { raw };
    },
    ['url', 'spawnImpl'],
    'read'
  )
  .pipe(
    (read: { raw: unknown }) => {
      const pr = summarizeNeoWorkPr(read.raw);
      const meta = GhPrSchema.safeParse(read.raw);
      return pr && meta.success
        ? {
            value: {
              pr,
              base: meta.data.baseRefName,
              mergeState: meta.data.mergeStateStatus,
              approvals: countNeoWorkPrApprovals(meta.data.reviews),
            },
          }
        : { reason: null };
    },
    'read',
    'result:pr'
  )
  .pipe(
    async (url: string, spawnImpl: SpawnFn, found: { pr: NeoWorkPr; base?: string }) => {
      if (!wantsNeoWorkPrBlockers(found.pr, found.base)) return { rules: [], detail: null };
      const pr = githubPr(url);
      return {
        rules: pr ? await readBranchRules(`${pr.owner}/${pr.repo}`, found.base!, spawnImpl) : [],
        detail: await readPrDetail(url, spawnImpl),
      };
    },
    ['url', 'spawnImpl', 'pr'],
    'extra'
  )
  .pipe(
    (
      found: { pr: NeoWorkPr; base?: string; mergeState?: string; approvals: number },
      extra: { rules: BranchRule[]; detail: PrDetail | null }
    ) => {
      const blockers = found.base
        ? planNeoWorkPrBlockers({
            base: found.base,
            mergeState: found.mergeState,
            approvals: found.approvals,
            ...extra,
          })
        : [];
      return blockers.length ? { ...found.pr, blockers } : found.pr;
    },
    ['pr', 'extra'],
    'pr'
  )
  .endAsync('pr') as (url: string, spawnImpl: SpawnFn) => Promise<NeoWorkPr | null>;

export async function readGithubPrs(
  urls: readonly string[],
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoWorkPr[] | null> {
  const prs: NeoWorkPr[] = [];
  for (const url of urls) {
    const pr = await readGithubPr(url, spawnImpl);
    if (pr) prs.push(pr);
  }
  return prs.length || !urls.length ? prs : null;
}

export function mergeNeoWorkPrReads(
  urls: readonly string[],
  read: readonly NeoWorkPr[],
  stored: readonly NeoWorkPr[] = []
): NeoWorkPr[] {
  const same = (url: string) => (pr: NeoWorkPr) => githubUrlKey(pr.url) === githubUrlKey(url);
  return [...new Set(urls.flatMap((url) => read.find(same(url)) ?? stored.find(same(url)) ?? []))];
}
