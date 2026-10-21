import {
  ARTIFACT_DEFAULT_LIMITS,
  type ArtifactRefusal,
} from '@hyperneo/shared/types/artifact-file';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { runGhJson } from '../github/gh-lookup-helpers.ts';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { sensitivePath, unsafePath } from './file-policy.ts';

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const limit = ARTIFACT_DEFAULT_LIMITS.artifactBytes;
const targetSchema = z.strictObject({
  repository: z.string().regex(/^github\.com\/[\w.-]+\/[\w.-]+$/),
  sha: oid,
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) =>
        !unsafePath(path) &&
        path.split('/').length <= 64 &&
        path.split('/').every((part) => !!part && part !== '.' && part !== '..')
    ),
});
type Target = z.infer<typeof targetSchema>;
type Blob = { accepted: true; bytes: Buffer; sha256: string; blobSha: string };
const unavailable = (): ArtifactRefusal => ({ accepted: false, reason: 'unavailable' });
const tooLarge = (actualBytes: number) => ({
  accepted: false as const,
  reason: 'size_limit' as const,
  actualBytes,
  limitBytes: limit,
});
const commitSchema = z.object({ sha: oid, tree: z.object({ sha: oid }) });
const treeSchema = z.object({
  sha: oid,
  truncated: z.literal(false),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: oid,
      size: z.number().int().nonnegative().optional(),
    })
  ),
});

async function json(target: Target, suffix: string, blob = false) {
  const endpoint = `repos/${target.repository.slice('github.com/'.length)}/git/${suffix}`;
  const result = await runGhJson(
    ['gh', 'api', '--hostname', 'github.com', endpoint],
    homedir(),
    spawnProcess,
    {
      stripGHRepo: true,
      hostHint: 'github.com',
      resourceHint: 'core',
      ...(blob ? { maxBufferBytes: Math.ceil(limit * 1.5) + 8192 } : {}),
    }
  );
  const data = result.ok ? result.data : null;
  return data &&
    typeof data === 'object' &&
    'url' in data &&
    typeof data.url === 'string' &&
    data.url.toLowerCase() === `https://api.github.com/${endpoint}`.toLowerCase()
    ? data
    : null;
}

async function locate(target: Target) {
  const commit = commitSchema.safeParse(await json(target, `commits/${target.sha}`));
  if (!commit.success || commit.data.sha !== target.sha) return { reason: unavailable() };
  let treeSha = commit.data.tree.sha;
  const parts = target.path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const tree = treeSchema.safeParse(await json(target, `trees/${treeSha}`));
    if (!tree.success || tree.data.sha !== treeSha) return { reason: unavailable() };
    const entries = tree.data.tree.filter((entry) => entry.path === parts[i]);
    const entry = entries.length === 1 ? entries[0] : null;
    if (!entry) return { reason: unavailable() };
    if (i < parts.length - 1) {
      if (entry.type !== 'tree' || entry.mode !== '040000') return { reason: unavailable() };
      treeSha = entry.sha;
    } else {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
        return { reason: unavailable() };
      return entry.size !== undefined && entry.size > limit
        ? { reason: tooLarge(entry.size) }
        : { value: entry.sha };
    }
  }
  return { reason: unavailable() };
}

async function download(target: Target, blobSha: string) {
  const parsed = z
    .object({
      sha: oid,
      encoding: z.literal('base64'),
      size: z.number().int().nonnegative(),
      content: z.string(),
    })
    .safeParse(await json(target, `blobs/${blobSha}`, true));
  if (!parsed.success || parsed.data.sha !== blobSha) return unavailable();
  if (parsed.data.size > limit) return tooLarge(parsed.data.size);
  const encoded = parsed.data.content.replace(/[\r\n]/g, '');
  if (encoded.length !== 4 * Math.ceil(parsed.data.size / 3)) return unavailable();
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length !== parsed.data.size ||
    bytes.toString('base64') !== encoded ||
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== blobSha
  )
    return unavailable();
  return {
    accepted: true as const,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    blobSha,
  };
}

export const readBoundGitBlob = (superpipe({})('artifact-bound-git-blob') as PipelineAPI)
  .input(['target'])
  .pipe(
    (target: Target) => {
      const parsed = targetSchema.safeParse(target);
      return parsed.success && !sensitivePath(parsed.data.path)
        ? { value: parsed.data }
        : { reason: unavailable() };
    },
    'target',
    'result:blob'
  )
  .pipe((target: Target) => ({ target }), 'blob', 'held')
  .pipe(locate, 'blob', 'result:blob')
  .pipe(
    (held: { target: Target }, blobSha: string) => download(held.target, blobSha),
    ['held', 'blob'],
    'blob'
  )
  .endAsync('blob') as (
  target: Target
) => Promise<Blob | ArtifactRefusal | ReturnType<typeof tooLarge>>;
