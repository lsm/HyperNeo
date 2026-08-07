/**
 * Deterministic side-effect primitives for the post-approval COMPLETION tail
 * (task #868).
 *
 * The actual PR merge is performed by the PR Merger LLM agent (`gh pr merge` in
 * `PR_MERGE_POST_APPROVAL_INSTRUCTIONS`). Once a PR is merged, however, the
 * remaining steps — branch cleanup, worktree fetch, Space checkout sync — are
 * deterministic and must NOT depend on the merger agent responding. This module
 * exposes those steps as an injectable interface so the daemon-side
 * {@link PostApprovalCompletionService} can drive them directly (and so recovery
 * can resume them after the merger stalls/dies).
 *
 * Every operation is idempotent: a branch already deleted is success, a
 * repeated `git fetch`/`pull --ff-only` is safe, and a missing path degrades to
 * a non-result warning rather than failing completion. The merger prompt's step
 * 4/5 guards are mirrored here so a daemon-side run produces the same outcome
 * the merger would have.
 *
 * Tests inject a stub {@link PostApprovalCompletionOps}; production wires
 * {@link createDefaultPostApprovalCompletionOps}, which shells out to `gh`
 * (via {@link runGhJson}) and `git`.
 */

import { DEFAULT_GH_LOOKUP_TIMEOUT_MS, runGhJson } from './gh-lookup-helpers';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from './gate-script-executor';

/** GitHub state for a PR, as needed to confirm + identify a merge. */
export interface PrMergeFacts {
  /** Raw PR state: `'MERGED' | 'OPEN' | 'CLOSED'`. */
  state: string;
  /** Convenience: `state === 'MERGED'`. */
  merged: boolean;
  /** Merge commit OID (`gh` returns `mergeCommit.oid`), when merged. */
  mergeCommit?: string;
  /** Base branch the PR merges into (`baseRefName`). */
  baseRefName?: string;
  /** Head OID at merge time (`headRefOid`). */
  headRefOid?: string;
  /** Head branch name (`headRefName`). */
  headRefName?: string;
  /** Whether the PR is from a fork (`isCrossRepository`) — fork branches are not deleted. */
  isCrossRepository?: boolean;
}

/** Outcome of a best-effort git operation. `warning` (never thrown) lets the
 *  caller record a NON-result artifact and continue. */
export interface GitOpResult {
  ok: boolean;
  /** Human-readable detail (success note or failure reason). */
  detail: string;
}

/** Outcome of remote-branch deletion. `alreadyGone` distinguishes "deleted just
 *  now" from "was already absent" — both are success. */
export interface BranchCleanupResult {
  ok: boolean;
  /** True when deletion was skipped because the PR is from a fork. */
  skippedFork?: boolean;
  /** True when the branch was already absent (idempotent success). */
  alreadyGone?: boolean;
  detail: string;
}

/**
 * Injectable side-effect surface for the post-approval completion tail. Each
 * method is best-effort and idempotent; failures surface as `{ ok: false }`
 * rather than throwing so a single failing cleanup step never strands the task.
 */
export interface PostApprovalCompletionOps {
  /** Query GitHub for the PR's merge state. `null` = lookup failed (treat as
   *  not-yet-confirmed; the reconciler retries on a later sweep). */
  fetchPrMergeFacts(prUrl: string): Promise<PrMergeFacts | null>;
  /** Delete the PR's remote head branch (same-repo only). Idempotent + OID-safe:
   *  if `expectedHeadOid` is provided, the remote ref is checked via
   *  `git ls-remote` and the branch is deleted only if it still matches, so a
   *  branch deleted-then-recreated with the same name is never clobbered. */
  deleteRemoteBranch(opts: {
    prUrl: string;
    headRefName: string;
    /** The merged PR's head OID — if provided, the delete is skipped when the
     *  remote ref no longer matches (branch was recreated). */
    expectedHeadOid?: string;
    /** cwd for the `git push` — typically the Space checkout. */
    workspacePath?: string;
  }): Promise<BranchCleanupResult>;
  /** Fetch the merged base into the task worktree (best-effort). */
  fetchWorktree(opts: { worktreePath?: string; baseBranch: string }): Promise<GitOpResult>;
  /** Fast-forward the Space checkout to the merged base (best-effort, guarded). */
  syncSpaceCheckout(opts: { workspacePath?: string; baseBranch: string }): Promise<GitOpResult>;
}

export interface DefaultCompletionOpsOptions {
  /** Spawn implementation (Bun.spawn in prod; a stub in tests). */
  spawnImpl: typeof Bun.spawn;
  /** Per-command timeout for git ops (default 30s, matching gh lookups). */
  gitTimeoutMs?: number;
  /** Per-command timeout for the `gh pr view` lookup. */
  ghTimeoutMs?: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Capture stdout/stderr + exit code for a subprocess command. */
async function runCommand(
  args: string[],
  cwd: string | undefined,
  spawnImpl: typeof Bun.spawn,
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  let proc;
  try {
    proc = spawnImpl(args, {
      cwd: cwd ?? '/tmp',
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
    collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
    proc.exited,
  ]);
  clearTimeout(killTimer);

  return {
    exitCode,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    timedOut: false,
  };
}

/** Minimal env for a trusted `git` subprocess (PATH + HOME + git credential env). */
function buildGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Reuse the same basic + GitHub credential allowlist as gh lookups so `git`
  // can authenticate pushes/fetches against the same hosts `gh` does.
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LANG',
    'TERM',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'GIT_TERMINAL_PROMPT',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_HOST',
    'GH_CONFIG_DIR',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    // SSH-agent credentials: a workspace whose remote uses SSH authenticates
    // via the running agent, so the push/fetch/pull subprocesses need these to
    // reach it (best-effort cleanup otherwise fails silently over SSH).
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'GIT_SSL_CAINFO',
  ];
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Never let git prompt interactively — fail fast instead of hanging completion.
  if (env.GIT_TERMINAL_PROMPT === undefined) env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * Production ops implementation: shells out to `gh` (via {@link runGhJson}) and
 * `git`. All git ops time out and degrade to `{ ok: false }` rather than throw.
 */
export function createDefaultPostApprovalCompletionOps(
  options: DefaultCompletionOpsOptions
): PostApprovalCompletionOps {
  const { spawnImpl } = options;
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const ghTimeoutMs = options.ghTimeoutMs ?? DEFAULT_GH_LOOKUP_TIMEOUT_MS;
  const gitEnv = buildGitEnv();

  return {
    async fetchPrMergeFacts(prUrl: string): Promise<PrMergeFacts | null> {
      const outcome = await runGhJson(
        [
          'gh',
          'pr',
          'view',
          prUrl,
          '--json',
          'state,mergeCommit,baseRefName,headRefOid,headRefName,isCrossRepository',
        ],
        '/tmp',
        spawnImpl,
        { timeoutMs: ghTimeoutMs }
      );
      if (!outcome.ok) return null;
      const data = outcome.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object') return null;
      const state = typeof data.state === 'string' ? data.state : '';
      const mergeCommitRaw = data.mergeCommit as { oid?: unknown } | null | undefined;
      const mergeCommit =
        mergeCommitRaw && typeof mergeCommitRaw.oid === 'string' ? mergeCommitRaw.oid : undefined;
      return {
        state,
        merged: state === 'MERGED',
        mergeCommit,
        baseRefName: typeof data.baseRefName === 'string' ? data.baseRefName : undefined,
        headRefOid: typeof data.headRefOid === 'string' ? data.headRefOid : undefined,
        headRefName: typeof data.headRefName === 'string' ? data.headRefName : undefined,
        isCrossRepository:
          typeof data.isCrossRepository === 'boolean' ? data.isCrossRepository : undefined,
      };
    },

    async deleteRemoteBranch(opts): Promise<BranchCleanupResult> {
      const { headRefName, workspacePath, expectedHeadOid } = opts;
      if (!headRefName) {
        return { ok: true, skippedFork: false, detail: 'no head branch name to delete' };
      }
      // Atomic compare-and-delete: when we have the merged PR's head OID, use
      // --force-with-lease=<branch>:<oid> so the delete only proceeds if the
      // remote ref STILL matches — a branch deleted-then-recreated (same name)
      // is never clobbered. This eliminates the ls-remote + push TOCTOU.
      const args = expectedHeadOid
        ? [
            'git',
            'push',
            'origin',
            `--force-with-lease=${headRefName}:${expectedHeadOid}`,
            '--delete',
            headRefName,
          ]
        : ['git', 'push', 'origin', '--delete', headRefName];
      const result = await runCommand(args, workspacePath, spawnImpl, gitEnv, gitTimeoutMs);
      if (result.exitCode === 0) {
        return { ok: true, detail: `deleted remote branch ${headRefName}` };
      }
      const stderr = result.stderr.trim();
      // "already gone" / "stale" / "rejected" signatures — idempotent success.
      const alreadyGone =
        /remote ref .* does not exist/i.test(stderr) ||
        /deleted.*does not exist/i.test(stderr) ||
        /no match/i.test(stderr) ||
        /refs\/heads\/.* not found/i.test(stderr) ||
        /stale info/i.test(stderr);
      // NOTE: do NOT classify "remote rejected" / "hook declined" as alreadyGone
      // — those are branch-protection / ruleset policy failures (the branch was
      // NOT deleted). Return ok: false so a cleanup-warning artifact is recorded.
      if (alreadyGone) {
        return {
          ok: true,
          alreadyGone: true,
          detail: `branch ${headRefName} absent, recreated (OID mismatch), or force-with-lease rejected`,
        };
      }
      return {
        ok: false,
        detail: `git push --delete ${headRefName} failed (exit ${result.exitCode}): ${stderr || 'no stderr'}`,
      };
    },

    async fetchWorktree(opts): Promise<GitOpResult> {
      const { worktreePath, baseBranch } = opts;
      if (!worktreePath) return { ok: true, detail: 'no task worktree path; skipped fetch' };
      const result = await runCommand(
        ['git', 'fetch', 'origin', baseBranch],
        worktreePath,
        spawnImpl,
        gitEnv,
        gitTimeoutMs
      );
      if (result.exitCode === 0)
        return { ok: true, detail: `fetched origin/${baseBranch} into worktree` };
      return {
        ok: false,
        detail: `worktree fetch failed (exit ${result.exitCode}): ${result.stderr.trim() || 'no stderr'}`,
      };
    },

    async syncSpaceCheckout(opts): Promise<GitOpResult> {
      const { workspacePath, baseBranch } = opts;
      if (!workspacePath) return { ok: true, detail: 'no workspace path; skipped sync' };
      // Guard: only fast-forward when the checkout is ON the base branch (mirrors
      // the merger prompt step 5 guard). A checkout on a different branch must
      // not be moved silently.
      const head = await runCommand(
        ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
        workspacePath,
        spawnImpl,
        gitEnv,
        gitTimeoutMs
      );
      if (head.exitCode !== 0) {
        return {
          ok: false,
          detail: `space checkout HEAD lookup failed (exit ${head.exitCode}): ${head.stderr.trim() || 'no stderr'}`,
        };
      }
      const currentBranch = head.stdout.trim();
      if (currentBranch !== baseBranch) {
        return {
          ok: false,
          detail: `space checkout is on '${currentBranch}', not '${baseBranch}'; left untouched`,
        };
      }
      const fetchRes = await runCommand(
        ['git', 'fetch', 'origin', baseBranch],
        workspacePath,
        spawnImpl,
        gitEnv,
        gitTimeoutMs
      );
      if (fetchRes.exitCode !== 0) {
        return {
          ok: false,
          detail: `space fetch failed (exit ${fetchRes.exitCode}): ${fetchRes.stderr.trim() || 'no stderr'}`,
        };
      }
      const pullRes = await runCommand(
        ['git', 'pull', '--ff-only', 'origin', baseBranch],
        workspacePath,
        spawnImpl,
        gitEnv,
        gitTimeoutMs
      );
      if (pullRes.exitCode !== 0) {
        return {
          ok: false,
          detail: `space pull --ff-only failed (exit ${pullRes.exitCode}): ${pullRes.stderr.trim() || 'no stderr'}`,
        };
      }
      // Step-5b secondary guard (mirrors the merger prompt): `pull --ff-only`
      // can print "Already up to date" while a local base AHEAD of origin/base
      // hides stray unmerged commits that later task worktrees would inherit.
      // Verify HEAD now equals origin/base; otherwise warn (non-fatal).
      const [localHead, remoteHead] = await Promise.all([
        runCommand(['git', 'rev-parse', 'HEAD'], workspacePath, spawnImpl, gitEnv, gitTimeoutMs),
        runCommand(
          ['git', 'rev-parse', `origin/${baseBranch}`],
          workspacePath,
          spawnImpl,
          gitEnv,
          gitTimeoutMs
        ),
      ]);
      const localOid = localHead.stdout.trim();
      const remoteOid = remoteHead.stdout.trim();
      if (localHead.exitCode === 0 && remoteHead.exitCode === 0 && localOid && remoteOid) {
        if (localOid !== remoteOid) {
          return {
            ok: false,
            detail: `space ${baseBranch} ahead of origin/${baseBranch} after pull (${localOid.slice(0, 8)} ≠ ${remoteOid.slice(0, 8)})`,
          };
        }
        return { ok: true, detail: `fast-forwarded space checkout to origin/${baseBranch}` };
      }
      // rev-parse failed — treat the successful pull as good but note it.
      return { ok: true, detail: `fast-forwarded space checkout to origin/${baseBranch}` };
    },
  };
}
