import type { WorkRef } from '../../../drivers/types.ts';
import { WorkDetailSchema, workResultSchema } from '../../../drivers/types.ts';
import type { OperationOutcome } from '../../../operations/invoke.ts';
import { isAbsolute } from 'node:path';
import type { WorktreeMetadata } from '@hyperneo/shared';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { NEO_WORK_PR_READ_MS } from './work-prs.ts';

type NeoWorkBranch = { branch: string; cwd: string };
export type NeoBranchPrReader = (branch: NeoWorkBranch) => Promise<string[]>;
type NeoWorkRepo = { owner: string; repo: string };
export type NeoWorkRepoReader = (cwd: string) => Promise<NeoWorkRepo | null>;

const NEO_BRANCH_PR_MAX = 2;
const NEO_BRANCH_PR_READ = 5;
const BranchPrsSchema = z.array(z.object({ url: z.string() }));
const RepoSchema = z.object({ owner: z.object({ login: z.string() }), name: z.string() });
const read = new Map<string, { at: number; urls: string[] }>();
const repos = new Map<string, { at: number; repo: NeoWorkRepo | null }>();
const NEO_WORK_REPO_MS = 60 * 60_000;
const ExecutionResultSchema = workResultSchema(
  WorkDetailSchema.pick({ ref: true, execution: true })
);

export function localCodingExecutionDirectory(
  ref: WorkRef | null,
  outcome: OperationOutcome | null,
  machine: string
): string | null {
  if (
    !ref ||
    ref.daemon !== undefined ||
    !['codex-desktop', 'claude-desktop'].includes(ref.adapter)
  )
    return null;
  const reply = ExecutionResultSchema.safeParse(
    outcome?.kind === 'completed' ? outcome.value : null
  );
  const detail = reply.success && reply.data.ok ? reply.data.value : null;
  const execution = detail?.execution;
  return detail?.ref.id === ref.id &&
    detail.ref.adapter === ref.adapter &&
    detail.ref.daemon === undefined &&
    execution?.machine === machine &&
    isAbsolute(execution.directory) &&
    !execution.directory.includes('\0')
    ? execution.directory
    : null;
}

export function localCodingSessionId(ref: WorkRef | null): string | null {
  return ref?.adapter === 'hyperneo' && !ref.daemon ? ref.id : null;
}

export function neoWorkBranch(
  session: { worktree?: WorktreeMetadata } | null
): NeoWorkBranch | null {
  return session?.worktree?.branch
    ? { branch: session.worktree.branch, cwd: session.worktree.worktreePath }
    : null;
}

export function neoWorkRepoCwd(
  session: { worktree?: WorktreeMetadata; workspacePath?: string | null } | null
): string | null {
  return session?.worktree?.worktreePath ?? session?.workspacePath ?? null;
}

export async function readGithubWorkRepo(
  cwd: string,
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoWorkRepo | null> {
  const cached = repos.get(cwd);
  if (cached && Date.now() - cached.at < NEO_WORK_REPO_MS) return cached.repo;
  const outcome = await runGhJson(['gh', 'repo', 'view', '--json', 'owner,name'], cwd, spawnImpl, {
    resourceHint: 'graphql',
    stripGHRepo: true,
  });
  if (!outcome.ok && outcome.retryable) return cached?.repo ?? null;
  const parsed = outcome.ok ? RepoSchema.safeParse(outcome.data) : null;
  const repo = parsed?.success ? { owner: parsed.data.owner.login, repo: parsed.data.name } : null;
  repos.set(cwd, { at: Date.now(), repo });
  return repo;
}

export function neoCardPrUrls(base: readonly string[], opened: readonly string[]): string[] {
  return [...base, ...opened.filter((url) => !base.includes(url)).slice(0, NEO_BRANCH_PR_MAX)];
}

export async function readGithubBranchPrs(
  branch: NeoWorkBranch,
  spawnImpl: SpawnFn = spawnProcess
): Promise<string[]> {
  const key = `${branch.cwd}:${branch.branch}`;
  const cached = read.get(key);
  if (cached && Date.now() - cached.at < NEO_WORK_PR_READ_MS) return cached.urls;
  const outcome = await runGhJson(
    [
      'gh',
      'pr',
      'list',
      '--head',
      branch.branch,
      '--state',
      'all',
      '--json',
      'url',
      '--limit',
      String(NEO_BRANCH_PR_READ),
    ],
    branch.cwd,
    spawnImpl,
    { resourceHint: 'graphql', stripGHRepo: true }
  );
  const parsed = outcome.ok ? BranchPrsSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) return cached?.urls ?? [];
  const urls = parsed.data.map((pr) => pr.url);
  read.set(key, { at: Date.now(), urls });
  return urls;
}
