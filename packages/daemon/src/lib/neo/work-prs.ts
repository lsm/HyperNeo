import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { runGhJson } from '../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';

export type NeoWorkPrReader = (urls: readonly string[]) => Promise<NeoWorkPr[] | null>;

export const NEO_WORK_PR_READ_MS = 2 * 60_000;
export const NEO_WORK_PR_STALE_MS = 30 * 60_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const GhPrSchema = z.object({
  url: z.string(),
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
  return [...new Set([...tracked.map((pr) => pr.url), ...(report?.match(PR_URL) ?? [])])].slice(
    0,
    8
  );
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
  const { url, state, headRefOid, reviews, statusCheckRollup } = parsed.data;
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
  return { url, state, checks, review };
}

export const isNeoWorkPrWaiting = (prs: readonly NeoWorkPr[]) =>
  prs.some((pr) => pr.state === 'OPEN' && pr.checks === 'pending');

export const neoWorkPrSignature = (prs: readonly NeoWorkPr[]) =>
  JSON.stringify(
    prs.map(({ url, state, checks, review, blockers }) => [
      url,
      state,
      checks,
      review,
      ...(blockers?.length ? [blockers] : []),
    ])
  );

type StoredPrs = {
  prs: readonly NeoWorkPr[];
  delivered: string | null;
  deliveredAt?: number | null;
  reminded?: string | null;
  readAt: number;
  readOkAt: number;
};

const NEO_WORK_PR_READY_MS = 30 * 60_000;

const isNeoWorkPrReady = (prs: readonly NeoWorkPr[]) =>
  prs.some(
    (pr) =>
      pr.state === 'OPEN' &&
      pr.review === 'approved' &&
      (pr.checks === 'passing' || pr.checks === 'none')
  );

export function shouldReadNeoWorkPrs(
  stored: StoredPrs | null,
  urls: readonly string[],
  now: number
): boolean {
  if (!urls.length) return false;
  if (!stored || urls.some((url) => !stored.prs.some((pr) => pr.url === url))) return true;
  return stored.prs.some((pr) => pr.state === 'OPEN') && now - stored.readAt >= NEO_WORK_PR_READ_MS;
}

export function planNeoWorkPrRefresh(
  row: StoredPrs,
  read: boolean,
  now: number,
  card: { quietSince: number; remindable: boolean } = { quietSince: 0, remindable: true }
): 'wait' | 'unchanged' | 'deliver' | 'remind' {
  const seen = neoWorkPrSignature(row.prs) === row.delivered;
  if (!read) return !seen && now - row.readOkAt >= NEO_WORK_PR_STALE_MS ? 'deliver' : 'wait';
  if (isNeoWorkPrWaiting(row.prs)) return 'wait';
  if (!seen) return 'deliver';
  const stalled =
    isNeoWorkPrReady(row.prs) &&
    card.remindable &&
    row.reminded !== row.delivered &&
    now - (row.deliveredAt ?? 0) >= NEO_WORK_PR_READY_MS &&
    now - card.quietSince >= NEO_WORK_PR_READY_MS;
  return stalled ? 'remind' : 'unchanged';
}

export function requireNeoWorkPrRefresh<Row extends { readAt: number }>(
  work: { status: string; report: string | null },
  card: { goal: boolean; row: Row | null; session: boolean; live: boolean },
  now: number,
  closedDone: string
): { value: Row } | { reason: null } {
  return work.status === 'reported' &&
    work.report !== closedDone &&
    card.goal &&
    card.live &&
    card.session &&
    card.row &&
    now - card.row.readAt >= NEO_WORK_PR_READ_MS
    ? { value: card.row }
    : { reason: null };
}

export function requireNeoWorkPrDelivery(
  plan: ReturnType<typeof planNeoWorkPrRefresh>
): { value: 'deliver' | 'remind' } | { reason: null } {
  return plan === 'deliver' || plan === 'remind' ? { value: plan } : { reason: null };
}

type BranchRule = {
  type: string;
  parameters?: {
    required_approving_review_count?: number | null;
    required_review_thread_resolution?: boolean | null;
  } | null;
};
type PrDetail = { commits: { oid: string; signed: boolean }[]; unresolved: number };

const PR_PARTS = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const RULES_MS = 10 * 60_000;
const rulesCache = new Map<string, { at: number; rules: BranchRule[] }>();
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

export function wantsNeoWorkPrBlockers(pr: NeoWorkPr, base: string | undefined): boolean {
  return (
    !!base &&
    pr.state === 'OPEN' &&
    pr.review !== 'changes_requested' &&
    (pr.checks === 'passing' || pr.checks === 'none')
  );
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
  if (['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(input.mergeState ?? '')) return [];
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

async function readBranchRules(repo: string, base: string, spawnImpl: SpawnFn) {
  const key = `${repo}:${base}`;
  const cached = rulesCache.get(key);
  if (cached && Date.now() - cached.at < RULES_MS) return cached.rules;
  const outcome = await gh(
    ['gh', 'api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}`],
    spawnImpl,
    'core'
  );
  const parsed = outcome.ok ? RulesSchema.safeParse(outcome.data) : null;
  const rules = parsed?.success ? parsed.data : [];
  if (parsed?.success) rulesCache.set(key, { at: Date.now(), rules });
  return rules;
}

async function readPrDetail(url: string, spawnImpl: SpawnFn): Promise<PrDetail | null> {
  const [, owner, name, number] = PR_PARTS.exec(url) ?? [];
  if (!number) return null;
  const outcome = await gh(
    [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${DETAIL_QUERY}`,
      '-f',
      `o=${owner}`,
      '-f',
      `n=${name}`,
      '-F',
      `p=${number}`,
    ],
    spawnImpl,
    'graphql'
  );
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
          'url,state,headRefOid,reviews,statusCheckRollup,mergeStateStatus,baseRefName',
        ],
        spawnImpl,
        'graphql'
      );
      return { raw: outcome.ok ? outcome.data : null };
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
      const [, owner, name] = PR_PARTS.exec(url) ?? [];
      return {
        rules: owner ? await readBranchRules(`${owner}/${name}`, found.base!, spawnImpl) : [],
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
    if (!pr) return null;
    prs.push(pr);
  }
  return prs;
}
