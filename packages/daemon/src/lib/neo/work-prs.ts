import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';

export type NeoWorkPrReader = (urls: readonly string[]) => Promise<NeoWorkPr[] | null>;

export const NEO_WORK_PR_READ_MS = 2 * 60_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const GhPrSchema = z.object({
  url: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefOid: z.string(),
  reviews: z.array(
    z.object({ state: z.string(), commit: z.object({ oid: z.string() }).nullish() })
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

export function extractNeoWorkPrUrls(report: string | null): string[] {
  return [...new Set(report?.match(PR_URL) ?? [])].slice(0, 5);
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
  JSON.stringify(prs.map(({ url, state, checks, review }) => [url, state, checks, review]));

export function planNeoWorkPrRefresh(row: {
  prs: readonly NeoWorkPr[];
  delivered: string | null;
}): 'wait' | 'unchanged' | 'deliver' {
  if (isNeoWorkPrWaiting(row.prs)) return 'wait';
  return neoWorkPrSignature(row.prs) === row.delivered ? 'unchanged' : 'deliver';
}

export async function readGithubPrs(
  urls: readonly string[],
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoWorkPr[] | null> {
  const prs: NeoWorkPr[] = [];
  for (const url of urls) {
    const outcome = await runGhJson(
      ['gh', 'pr', 'view', url, '--json', 'url,state,headRefOid,reviews,statusCheckRollup'],
      homedir(),
      spawnImpl,
      { resourceHint: 'graphql' }
    );
    const pr = outcome.ok ? summarizeNeoWorkPr(outcome.data) : null;
    if (!pr) return null;
    prs.push(pr);
  }
  return prs;
}
