import type { ArtifactPrSummary } from '@hyperneo/shared/types/artifact-pr';
import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { runGhJson } from '../github/gh-lookup-helpers.ts';
import { summarizeNeoWorkPr } from '../neo/packs/coding/work-prs.ts';
import { spawnProcess, type SpawnFn } from '../runtime-spawn/index.ts';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f\\]/.test(value) &&
      value.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
const file = z.strictObject({ path, additions: count, deletions: count });
export const ArtifactPrSummarySchema: z.ZodType<ArtifactPrSummary> = z.strictObject({
  url: z.string().url(),
  repository: z.string(),
  number: count.min(1),
  title: z.string().min(1).max(1000),
  body: z
    .string()
    .max(65536)
    .refine((value) => Buffer.byteLength(value) <= 128 * 1024),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  checks: z.enum(['pending', 'failing', 'passing', 'none']),
  review: z.enum(['approved', 'changes_requested', 'none']),
  changedFiles: count,
  files: z.array(file).max(1000),
  filesTruncated: z.boolean(),
});
const raw = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  headRefOid: z.string(),
  changedFiles: count,
  files: z.array(z.object(file.shape)).max(1000),
});
type Target = { repository: string; number: number };
type Planned = Target & { url: string; args: string[] };

function requireKnownPr(target: Target) {
  return /^github\.com\/[\w.-]+\/[\w.-]+$/.test(target.repository) &&
    Number.isSafeInteger(target.number) &&
    target.number > 0
    ? {
        value: {
          ...target,
          url: `https://${target.repository}/pull/${target.number}`,
          args: [
            'gh',
            'pr',
            'view',
            String(target.number),
            '--repo',
            target.repository,
            '--json',
            'url,title,body,state,headRefOid,reviews,statusCheckRollup,changedFiles,files',
          ],
        },
      }
    : { reason: null };
}

function present(plan: Planned, response: { data: unknown }) {
  const parsed = raw.safeParse(response.data);
  const status = summarizeNeoWorkPr(response.data);
  if (!parsed.success || !status || parsed.data.url.toLowerCase() !== plan.url.toLowerCase())
    return { reason: null };
  const { title, body, files, changedFiles, headRefOid } = parsed.data;
  if (files.length > changedFiles || new Set(files.map((item) => item.path)).size !== files.length)
    return { reason: null };
  const result = ArtifactPrSummarySchema.safeParse({
    url: plan.url,
    repository: plan.repository,
    number: plan.number,
    title,
    body,
    state: status.state,
    headSha: headRefOid,
    checks: status.checks,
    review: status.review,
    changedFiles,
    files,
    filesTruncated: changedFiles > files.length,
  });
  return result.success ? { value: result.data } : { reason: null };
}

export const readArtifactPrSummary = (superpipe({})('artifact-github-pr-summary') as PipelineAPI)
  .input(['target', 'spawnImpl'])
  .pipe(requireKnownPr, 'target', 'result:summary')
  .pipe(
    async (plan: Planned, spawnImpl: SpawnFn) => {
      const response = await runGhJson(plan.args, homedir(), spawnImpl, {
        stripGHRepo: true,
        hostHint: 'github.com',
        resourceHint: 'graphql',
      });
      return { data: response.ok ? response.data : null };
    },
    ['summary', 'spawnImpl'],
    'response'
  )
  .pipe(present, ['summary', 'response'], 'result:summary')
  .endAsync('summary') as (target: Target, spawnImpl: SpawnFn) => Promise<ArtifactPrSummary | null>;

export const readBoundPrSummary = (target: Target) => readArtifactPrSummary(target, spawnProcess);
