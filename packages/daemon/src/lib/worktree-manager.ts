import simpleGit, { SimpleGit } from 'simple-git';
import { execFile } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type {
  WorktreeMetadata,
  CommitInfo,
  WorktreeCommitStatus,
  GitBranchesResponse,
  GitChangedFile,
  GitFileStatusKind,
  GitReviewFile,
  GitReviewSummary,
  GitCheckSummary,
  GitPullRequestSummary,
  GitSessionStatusResponse,
  GitFileDiffResponse,
  Session,
} from '@hyperneo/shared';
import { Logger } from './logger';
import { getProjectShortKey, getWorktreeBaseDir } from './worktree-path-utils';

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isPrunable: boolean;
}

export interface CreateWorktreeOptions {
  sessionId: string;
  repoPath: string;
  branchName?: string; // Optional custom branch name
  baseBranch?: string;
}

const MAX_REVIEW_FILES = 80;
const MAX_PATCH_CHARS = 24_000;
/** Safety cap for the on-demand full-file diff (`git.fileDiff`). Large enough
 * that real diffs are effectively untruncated, while still bounding memory. */
const MAX_FULL_PATCH_CHARS = 1_000_000;
const GH_TIMEOUT_MS = 8_000;

/** Prefix a pathspec with `:(literal)` so filenames containing glob
 * metacharacters (*, ?, []) are matched literally instead of as patterns —
 * `--` only separates options from pathspecs, it doesn't disable globbing. */
function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

const EMPTY_REVIEW: GitReviewSummary = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  pullRequest: null,
  checks: [],
};

export class WorktreeManager {
  private gitCache = new Map<string, SimpleGit>();
  private logger = new Logger('WorktreeManager');

  /**
   * Get or create a SimpleGit instance for a repository
   */
  private getGit(repoPath: string): SimpleGit {
    if (!this.gitCache.has(repoPath)) {
      this.gitCache.set(repoPath, simpleGit(repoPath));
    }
    return this.gitCache.get(repoPath)!;
  }

  /**
   * Find the git repository root for a given path
   * Returns null if path is not in a git repository
   */
  async findGitRoot(path: string): Promise<string | null> {
    try {
      let currentPath = normalize(path);
      const root = dirname(currentPath);

      // Traverse up to find .git directory
      while (currentPath !== root) {
        if (existsSync(join(currentPath, '.git'))) {
          // Verify it's actually a git repo
          const git = this.getGit(currentPath);
          await git.revparse(['--git-dir']);
          return currentPath;
        }
        currentPath = dirname(currentPath);
      }

      // Check root directory
      if (existsSync(join(root, '.git'))) {
        const git = this.getGit(root);
        await git.revparse(['--git-dir']);
        return root;
      }

      this.logger.warn(`No .git found traversing from: ${path}`);
      return null;
    } catch (error) {
      this.logger.warn(`findGitRoot failed for ${path}:`, error);
      return null;
    }
  }

  /**
   * Detect if workspace supports worktrees (is a git repository)
   * WITHOUT creating a worktree
   *
   * @param workspacePath - Path to check for git repository
   * @returns Object with isGitRepo flag and gitRoot path
   */
  async detectGitSupport(workspacePath: string): Promise<{
    isGitRepo: boolean;
    gitRoot: string | null;
  }> {
    const gitRoot = await this.findGitRoot(workspacePath);
    return {
      isGitRepo: gitRoot !== null,
      gitRoot,
    };
  }

  /**
   * Collect git context for a folder path: repo detection, local branches,
   * current/default branch, and whether the working tree is dirty.
   *
   * Used by the `git.branches` RPC to drive workspace/worktree/branch pickers.
   * Never throws — non-git paths and partial git failures degrade to a safe,
   * mostly-empty response.
   */
  async getRepoGitInfo(workspacePath: string): Promise<GitBranchesResponse> {
    const empty: GitBranchesResponse = {
      isGitRepo: false,
      gitRoot: null,
      currentBranch: null,
      defaultBranch: null,
      branches: [],
      isDirty: false,
    };

    const trimmed = workspacePath?.trim();
    if (!trimmed) return empty;

    const gitRoot = await this.findGitRoot(trimmed);
    if (!gitRoot) return empty;

    const git = this.getGit(gitRoot);

    let branches: string[] = [];
    let currentBranch: string | null = null;
    try {
      const summary = await git.branchLocal();
      branches = summary.all;
      // `current` is an empty string on a detached or unborn HEAD.
      currentBranch = summary.current ? summary.current : null;
    } catch (error) {
      this.logger.warn(`getRepoGitInfo: failed to list branches for ${gitRoot}:`, error);
    }

    let defaultBranch: string | null = null;
    try {
      const detected = await this.getDefaultBranch(gitRoot);
      // getDefaultBranch returns the 'HEAD' sentinel when it cannot resolve a
      // real branch — surface that as null so callers don't treat it as one.
      defaultBranch = detected && detected !== 'HEAD' ? detected : null;
    } catch (error) {
      this.logger.warn(`getRepoGitInfo: failed to resolve default branch for ${gitRoot}:`, error);
    }

    let isDirty = false;
    try {
      const status = await git.status();
      isDirty = !status.isClean();
    } catch (error) {
      this.logger.warn(`getRepoGitInfo: failed to read status for ${gitRoot}:`, error);
    }

    return { isGitRepo: true, gitRoot, currentBranch, defaultBranch, branches, isDirty };
  }

  /**
   * Collect read-only Git status for a session's effective workspace.
   *
   * Worktree sessions report both the original project path and the isolated
   * worktree path. Direct sessions report the project path only. Never mutates
   * repository state.
   */
  async getSessionGitStatus(session: Session): Promise<GitSessionStatusResponse> {
    const mode = session.worktree ? 'worktree' : session.workspacePath ? 'direct' : 'none';
    const workspacePath = session.workspacePath ?? null;
    const worktreePath = session.worktree?.worktreePath ?? null;
    const effectivePath = worktreePath ?? workspacePath;

    const empty: GitSessionStatusResponse = {
      sessionId: session.id,
      mode,
      isGitRepo: false,
      workspacePath,
      worktreePath,
      mainRepoPath: session.worktree?.mainRepoPath ?? null,
      gitRoot: null,
      branch: session.worktree?.branch ?? session.gitBranch ?? null,
      baseBranch: null,
      defaultBranch: null,
      isDirty: false,
      files: [],
      commitsAhead: [],
      aheadCount: null,
      behindCount: null,
      review: EMPTY_REVIEW,
    };

    if (!effectivePath) return empty;

    const repoInfo = await this.getRepoGitInfo(effectivePath);
    if (!repoInfo.isGitRepo || !repoInfo.gitRoot) {
      return { ...empty, isGitRepo: false };
    }

    const mainRepoPath =
      session.worktree?.mainRepoPath ??
      (await this.resolveMainRepoPath(effectivePath)) ??
      repoInfo.gitRoot;
    const branch =
      session.worktree?.branch ??
      repoInfo.currentBranch ??
      session.gitBranch ??
      (await this.getCurrentBranch(effectivePath));

    let files: GitChangedFile[] = [];
    let fileStatusError: string | undefined;
    try {
      files = await this.getChangedFiles(effectivePath);
    } catch (error) {
      fileStatusError = error instanceof Error ? error.message : String(error);
    }

    let baseBranch = repoInfo.defaultBranch;
    let commitsAhead: CommitInfo[] = [];
    let aheadCount: number | null = null;
    let behindCount: number | null = null;
    let review: GitReviewSummary = EMPTY_REVIEW;

    try {
      if (session.worktree) {
        const commitStatus = await this.getCommitsAhead(session.worktree);
        baseBranch = commitStatus.baseBranch;
        commitsAhead = commitStatus.commits;
      }

      if (baseBranch && branch && baseBranch !== branch) {
        const counts = await this.getAheadBehind(mainRepoPath, baseBranch, branch);
        aheadCount = counts.ahead;
        behindCount = counts.behind;
        if (!session.worktree && aheadCount > 0) {
          commitsAhead = await this.getCommitLog(mainRepoPath, baseBranch, branch);
        }
      } else if (baseBranch && branch) {
        aheadCount = 0;
        behindCount = 0;
      }

      review = await this.getReviewSummary(repoInfo.gitRoot, baseBranch, branch, files);
    } catch (error) {
      return {
        ...empty,
        isGitRepo: true,
        mainRepoPath,
        gitRoot: repoInfo.gitRoot,
        branch,
        baseBranch,
        defaultBranch: repoInfo.defaultBranch,
        isDirty: files.length > 0 || repoInfo.isDirty,
        files,
        review,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      sessionId: session.id,
      mode,
      isGitRepo: true,
      workspacePath,
      worktreePath,
      mainRepoPath,
      gitRoot: repoInfo.gitRoot,
      branch,
      baseBranch,
      defaultBranch: repoInfo.defaultBranch,
      isDirty: files.length > 0 || repoInfo.isDirty,
      files,
      commitsAhead,
      aheadCount,
      behindCount,
      review,
      error: fileStatusError,
    };
  }

  /**
   * Full (untruncated) combined diff for a single file in a session's workspace.
   * Read-only; mirrors the patch ranges used by `getReviewSummary` so the result
   * matches the truncated preview shown in the Git panel. Used to expand a diff
   * that was capped at MAX_PATCH_CHARS in the review payload.
   */
  async getSessionFileDiff(session: Session, path: string): Promise<GitFileDiffResponse> {
    const worktreePath = session.worktree?.worktreePath ?? null;
    const workspacePath = session.workspacePath ?? null;
    const effectivePath = worktreePath ?? workspacePath;
    const empty: GitFileDiffResponse = {
      sessionId: session.id,
      path: path ?? '',
      patch: null,
      truncated: false,
      additions: 0,
      deletions: 0,
    };
    // Reject empty/all-whitespace requests, but keep the original path for git
    // operations — a tracked file's path may legitimately begin or end with
    // whitespace, and trimming it would query a different file.
    if (!effectivePath || !path || !path.trim()) return empty;

    const repoInfo = await this.getRepoGitInfo(effectivePath);
    if (!repoInfo.isGitRepo || !repoInfo.gitRoot) {
      return { ...empty, error: 'Not a git repository' };
    }

    // Porcelain/diff paths are repository-root-relative, but git pathspecs
    // resolve relative to the client's cwd. Run from gitRoot so `-- <path>`
    // matches — effectivePath may be a subdirectory of the repo, in which case
    // a repo-root-relative pathspec would otherwise resolve to <sub>/<sub>/…
    // and return no patch. (For worktree sessions gitRoot == the worktree root.)
    const git = this.getGit(repoInfo.gitRoot);
    const branch = session.worktree?.branch ?? repoInfo.currentBranch ?? session.gitBranch ?? null;

    // Resolve the same base branch the review uses so the range matches.
    let baseBranch = repoInfo.defaultBranch;
    if (session.worktree) {
      try {
        const commitStatus = await this.getCommitsAhead(session.worktree);
        baseBranch = commitStatus.baseBranch;
      } catch {
        // Fall back to the detected default branch.
      }
    }

    let branchResult: { patch: string | null; truncated: boolean } = {
      patch: null,
      truncated: false,
    };
    if (baseBranch && branch && baseBranch !== branch) {
      branchResult = await this.getFilePatch(
        git,
        [`${baseBranch}...${branch}`, '--', literalPathspec(path)],
        MAX_FULL_PATCH_CHARS
      );
    }

    // Working-tree patch vs HEAD (untracked files have no HEAD diff).
    let worktreeResult: { patch: string | null; truncated: boolean } = {
      patch: null,
      truncated: false,
    };
    let isUntracked = false;
    try {
      const files = await this.getChangedFiles(repoInfo.gitRoot);
      const file = files.find((entry) => entry.path === path);
      if (file?.status === 'untracked') isUntracked = true;
    } catch {
      // Best-effort: assume tracked and attempt the diff below.
    }
    if (!isUntracked) {
      worktreeResult = await this.getFilePatch(
        git,
        ['HEAD', '--', literalPathspec(path)],
        MAX_FULL_PATCH_CHARS
      );
    }

    const combined = this.combinePatches(
      branchResult.patch,
      worktreeResult.patch,
      MAX_FULL_PATCH_CHARS
    );

    // Additions/deletions across the same ranges (branch + working tree).
    let additions = 0;
    let deletions = 0;
    const ranges: string[][] =
      baseBranch && branch && baseBranch !== branch
        ? [[`${baseBranch}...${branch}`], ['HEAD']]
        : [['HEAD']];
    for (const range of ranges) {
      try {
        const stat = (await this.getNumstatMap(git, range, literalPathspec(path))).get(path);
        if (stat) {
          additions += stat.additions;
          deletions += stat.deletions;
        }
      } catch {
        // Stats are best-effort.
      }
    }

    return {
      sessionId: session.id,
      path: path,
      patch: combined.patch,
      // combinePatches reports truncation only when the *combined* length
      // exceeds the cap; preserve the per-read flags so a single truncated
      // patch isn't presented as the complete diff.
      truncated: combined.truncated || branchResult.truncated || worktreeResult.truncated,
      additions,
      deletions,
    };
  }

  private async getReviewSummary(
    gitRoot: string,
    baseBranch: string | null,
    branch: string | null,
    workingTreeFiles: GitChangedFile[]
  ): Promise<GitReviewSummary> {
    // Run from the git working-tree root: porcelain/numstat paths are
    // repo-root-relative, and git pathspecs resolve relative to the client's
    // cwd, so a client started from a workspace subdir would resolve
    // `-- <repo-relative-path>` to <subdir>/<repo-relative-path> and return no
    // patch. gitRoot is the worktree root for worktree sessions and the repo
    // root for direct sessions.
    const git = this.getGit(gitRoot);
    const reviewFiles = new Map<string, GitReviewFile>();

    if (baseBranch && branch && baseBranch !== branch) {
      await this.addBranchReviewFiles(git, reviewFiles, baseBranch, branch);
    }

    await this.addWorkingTreeReviewFiles(git, reviewFiles, workingTreeFiles);

    const files = [...reviewFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
    const github = await this.getGitHubReviewSummary(gitRoot);

    return {
      files,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      pullRequest: github.pullRequest,
      checks: github.checks,
      githubError: github.error,
    };
  }

  private async addBranchReviewFiles(
    git: SimpleGit,
    reviewFiles: Map<string, GitReviewFile>,
    baseBranch: string,
    branch: string
  ): Promise<void> {
    let nameStatusOutput = '';
    try {
      nameStatusOutput = await git.raw([
        'diff',
        '--name-status',
        '-z',
        `${baseBranch}...${branch}`,
      ]);
    } catch {
      return;
    }

    const stats = await this.getNumstatMap(git, [`${baseBranch}...${branch}`]);
    const entries = nameStatusOutput.split('\0').filter(Boolean);

    for (let index = 0; index < entries.length && reviewFiles.size < MAX_REVIEW_FILES; index++) {
      const statusCode = entries[index];
      const statusLetter = statusCode[0];
      let oldPath: string | undefined;
      let path = entries[++index];

      if (!path) continue;

      if (statusLetter === 'R' || statusLetter === 'C') {
        oldPath = path;
        path = entries[++index];
        if (!path) continue;
      }

      const stat = stats.get(path) ?? { additions: 0, deletions: 0 };
      const patchResult = await this.getFilePatch(git, [`${baseBranch}...${branch}`, '--', path]);
      reviewFiles.set(path, {
        path,
        oldPath,
        status: this.gitStatusKind(statusLetter, ' '),
        additions: stat.additions,
        deletions: stat.deletions,
        patch: patchResult.patch,
        patchTruncated: patchResult.truncated,
        source: 'branch',
      });
    }
  }

  private async addWorkingTreeReviewFiles(
    git: SimpleGit,
    reviewFiles: Map<string, GitReviewFile>,
    workingTreeFiles: GitChangedFile[]
  ): Promise<void> {
    const stats = await this.getNumstatMap(git, ['HEAD']);

    for (const file of workingTreeFiles) {
      if (reviewFiles.size >= MAX_REVIEW_FILES && !reviewFiles.has(file.path)) break;

      const stat = stats.get(file.path) ?? { additions: 0, deletions: 0 };
      const patchResult =
        file.status === 'untracked'
          ? { patch: null, truncated: false }
          : await this.getFilePatch(git, ['HEAD', '--', file.path]);
      const existing = reviewFiles.get(file.path);

      const combinedPatch = this.combinePatches(existing?.patch ?? null, patchResult.patch);
      reviewFiles.set(file.path, {
        path: file.path,
        oldPath: file.oldPath ?? existing?.oldPath,
        status: file.status !== 'other' ? file.status : (existing?.status ?? file.status),
        additions: (existing?.additions ?? 0) + stat.additions,
        deletions: (existing?.deletions ?? 0) + stat.deletions,
        patch: combinedPatch.patch,
        patchTruncated:
          (existing?.patchTruncated ?? false) || patchResult.truncated || combinedPatch.truncated,
        source: existing ? 'both' : 'working_tree',
      });
    }
  }

  private async getNumstatMap(
    git: SimpleGit,
    rangeArgs: string[],
    pathspec?: string
  ): Promise<Map<string, { additions: number; deletions: number }>> {
    const stats = new Map<string, { additions: number; deletions: number }>();
    try {
      // When a pathspec is given, scope numstat to that one file so the
      // single-file RPC doesn't parse stats for every changed file in the range.
      const args = ['diff', '--numstat', ...rangeArgs];
      if (pathspec) args.push('--', pathspec);
      const output = await git.raw(args);
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const [additionsRaw, deletionsRaw, path] = line.split('\t');
        if (!path) continue;
        stats.set(this.normalizeNumstatPath(path), {
          additions: Number.parseInt(additionsRaw, 10) || 0,
          deletions: Number.parseInt(deletionsRaw, 10) || 0,
        });
      }
    } catch {
      // Diff stats are best-effort for the panel; status and patches still render.
    }
    return stats;
  }

  private normalizeNumstatPath(path: string): string {
    if (!path.includes(' => ')) return path;

    const braceRename = path.match(/^(.*)\{(.+) => (.+)\}(.*)$/);
    if (braceRename) {
      return `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
    }

    return path.slice(path.lastIndexOf(' => ') + 4);
  }

  private async getFilePatch(
    git: SimpleGit,
    rangeArgs: string[],
    maxChars = MAX_PATCH_CHARS
  ): Promise<{ patch: string | null; truncated: boolean }> {
    try {
      const patch = await git.raw(['diff', '--no-ext-diff', '--no-color', ...rangeArgs]);
      if (!patch.trim()) return { patch: null, truncated: false };
      if (patch.length <= maxChars) return { patch, truncated: false };
      return { patch: patch.slice(0, maxChars), truncated: true };
    } catch {
      return { patch: null, truncated: false };
    }
  }

  private combinePatches(
    first: string | null,
    second: string | null,
    maxChars = MAX_PATCH_CHARS
  ): { patch: string | null; truncated: boolean } {
    if (!first) return { patch: second, truncated: false };
    if (!second) return { patch: first, truncated: false };
    const combined = `${first.trimEnd()}\n\n${second}`;
    if (combined.length <= maxChars) return { patch: combined, truncated: false };
    return { patch: combined.slice(0, maxChars), truncated: true };
  }

  private async getGitHubReviewSummary(repoPath: string): Promise<{
    pullRequest: GitPullRequestSummary | null;
    checks: GitCheckSummary[];
    error?: string;
  }> {
    const prResult = await this.execGhJson(repoPath, [
      'pr',
      'view',
      '--json',
      'number,title,url,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName,additions,deletions',
    ]);

    if (!prResult.ok) {
      return { pullRequest: null, checks: [], error: prResult.error };
    }

    const pullRequest = this.parsePullRequestSummary(prResult.data);
    const checksResult = await this.execGhJson(repoPath, [
      'pr',
      'checks',
      '--json',
      'name,state,bucket,link',
    ]);

    return {
      pullRequest,
      checks: checksResult.ok ? this.parseCheckSummaries(checksResult.data) : [],
      error: checksResult.ok ? undefined : checksResult.error,
    };
  }

  private async execGhJson(
    cwd: string,
    args: string[]
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      execFile(
        'gh',
        args,
        { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const output = typeof stdout === 'string' ? stdout.trim() : '';
          if (output) {
            try {
              resolve({ ok: true, data: JSON.parse(output) });
              return;
            } catch {
              // Fall through to a readable error below.
            }
          }
          const message =
            (typeof stderr === 'string' && stderr.trim()) ||
            (error instanceof Error ? error.message : 'GitHub CLI request failed');
          resolve({ ok: false, error: message });
        }
      );
    });
  }

  private parsePullRequestSummary(data: unknown): GitPullRequestSummary | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const number = typeof record.number === 'number' ? record.number : null;
    if (!number) return null;

    return {
      number,
      title: typeof record.title === 'string' ? record.title : `PR #${number}`,
      url: typeof record.url === 'string' ? record.url : '',
      state: typeof record.state === 'string' ? record.state : 'UNKNOWN',
      isDraft: record.isDraft === true,
      mergeable: typeof record.mergeable === 'string' ? record.mergeable : null,
      reviewDecision: typeof record.reviewDecision === 'string' ? record.reviewDecision : null,
      headRefName: typeof record.headRefName === 'string' ? record.headRefName : null,
      baseRefName: typeof record.baseRefName === 'string' ? record.baseRefName : null,
      additions: typeof record.additions === 'number' ? record.additions : 0,
      deletions: typeof record.deletions === 'number' ? record.deletions : 0,
    };
  }

  private parseCheckSummaries(data: unknown): GitCheckSummary[] {
    if (!Array.isArray(data)) return [];
    return data
      .map((item): GitCheckSummary | null => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name : null;
        if (!name) return null;
        return {
          name,
          state: typeof record.state === 'string' ? record.state : 'UNKNOWN',
          bucket: typeof record.bucket === 'string' ? record.bucket : null,
          url: typeof record.link === 'string' ? record.link : null,
        };
      })
      .filter((check): check is GitCheckSummary => check !== null);
  }

  private async getChangedFiles(repoPath: string): Promise<GitChangedFile[]> {
    const git = this.getGit(repoPath);
    const output = await git.raw(['status', '--porcelain=v1', '-z']);
    const entries = output.split('\0').filter(Boolean);
    const files: GitChangedFile[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4) continue;

      const stagedCode = entry[0];
      const unstagedCode = entry[1];
      if (stagedCode === '!' && unstagedCode === '!') continue;

      const isRename = stagedCode === 'R' || unstagedCode === 'R';
      const isCopy = stagedCode === 'C' || unstagedCode === 'C';
      const path = entry.slice(3);
      const oldPath = isRename || isCopy ? entries[++i] : undefined;

      files.push({
        path,
        oldPath,
        status: this.gitStatusKind(stagedCode, unstagedCode),
        staged: stagedCode !== ' ' && stagedCode !== '?' && stagedCode !== '!',
        // Working-tree column — not the inverse of `staged`: an `MM` file has
        // both true. Untracked (`?`) counts as unstaged (working-tree only).
        unstaged: unstagedCode !== ' ' && unstagedCode !== '!',
      });
    }

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private gitStatusKind(stagedCode: string, unstagedCode: string): GitFileStatusKind {
    if (
      stagedCode === 'U' ||
      unstagedCode === 'U' ||
      (stagedCode === 'A' && unstagedCode === 'A') ||
      (stagedCode === 'D' && unstagedCode === 'D')
    ) {
      return 'conflicted';
    }
    if (stagedCode === '?' || unstagedCode === '?') return 'untracked';
    if (stagedCode === 'R' || unstagedCode === 'R') return 'renamed';

    const code = unstagedCode !== ' ' ? unstagedCode : stagedCode;
    switch (code) {
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'M':
      case 'T':
        return 'modified';
      default:
        return 'other';
    }
  }

  private async getAheadBehind(
    repoPath: string,
    baseBranch: string,
    branch: string
  ): Promise<{ ahead: number; behind: number }> {
    const git = this.getGit(repoPath);
    const output = await git.raw([
      'rev-list',
      '--left-right',
      '--count',
      `${baseBranch}...${branch}`,
    ]);
    const [behindRaw, aheadRaw] = output.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
      behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
    };
  }

  private async getCommitLog(
    repoPath: string,
    baseBranch: string,
    branch: string
  ): Promise<CommitInfo[]> {
    const git = this.getGit(repoPath);
    const output = await git.raw([
      'log',
      `${baseBranch}..${branch}`,
      '--max-count=20',
      '--format=%H|%an|%ai|%s',
    ]);

    if (!output.trim()) return [];

    return output
      .trim()
      .split('\n')
      .map((line) => {
        const [fullHash, author, date, ...messageParts] = line.split('|');
        return {
          hash: fullHash.substring(0, 7),
          author,
          date,
          message: messageParts.join('|'),
        };
      });
  }

  /**
   * Check if a git branch exists
   */
  private async checkBranchExists(repoPath: string, branchName: string): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      const result = await git.raw(['branch', '--list', branchName]);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the main repository path from a worktree path.
   *
   * For linked worktrees (created via `git worktree add`), the .git inside
   * the worktree is a file (not a directory) that points to the main repo's
   * git directory. This method correctly resolves the main repo root.
   *
   * @param worktreePath - Path inside a worktree
   * @returns The main repository root path, or null if not a worktree
   */
  async resolveMainRepoPath(worktreePath: string): Promise<string | null> {
    try {
      const git = this.getGit(worktreePath);

      // Get the absolute path to the .git directory
      // For main repo: /path/to/repo/.git
      // For worktree: /path/to/main/repo/.git/worktrees/<name>
      // Use --git-dir (not --git-common-dir) because --git-dir returns the
      // actual git directory path including worktrees subdirectory
      const gitDir = await git.revparse(['--path-format=absolute', '--git-dir']);

      if (!gitDir) {
        return null;
      }

      // Check if this is a worktree by looking for /worktrees/ in the path
      const worktreesMatch = gitDir.match(/^(.+?\.git)[/\\]worktrees[/\\]/);

      if (worktreesMatch) {
        // This is a linked worktree - the main repo is the parent of .git
        const mainGitDir = worktreesMatch[1];
        return dirname(mainGitDir);
      }

      // This might be the main repo itself or not a worktree
      // Return the git root from findGitRoot
      return this.findGitRoot(worktreePath);
    } catch (error) {
      this.logger.warn(`resolveMainRepoPath failed for ${worktreePath}:`, error);
      return null;
    }
  }

  /**
   * Produce a short, deterministic, human-readable directory name for a repo path.
   *
   * Delegates to the standalone {@link getProjectShortKey} utility.
   * Kept as a public instance method for backward compatibility.
   */
  public getProjectShortKey(repoPath: string): string {
    return getProjectShortKey(repoPath);
  }

  /**
   * Get the worktree base directory for a repository.
   *
   * Delegates to the standalone {@link getWorktreeBaseDir} utility.
   * Kept as a private instance method to avoid cascading async changes.
   */
  private getWorktreeBaseDir(gitRoot: string): string {
    return getWorktreeBaseDir(gitRoot, (msg) => this.logger.warn(msg));
  }

  /**
   * Create a new worktree for a session
   * Returns WorktreeMetadata on success, null if repo is not a git repository
   */
  async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeMetadata | null> {
    const { sessionId, repoPath, branchName: customBranchName, baseBranch = 'HEAD' } = options;

    // Find git root
    const gitRoot = await this.findGitRoot(repoPath);
    if (!gitRoot) {
      this.logger.warn(`createWorktree: no git root found for repoPath=${repoPath}`);
      return null;
    }

    const git = this.getGit(gitRoot);

    // Create worktree base directory if it doesn't exist
    // Format: ~/.hyperneo/projects/{shortKey}/worktrees/
    const worktreesDir = this.getWorktreeBaseDir(gitRoot);
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    // Generate worktree path and branch name
    // Colons are invalid in git branch names (git check-ref-format) and can
    // confuse tools when used in filesystem paths.  Room session IDs use
    // colons (e.g. planner:roomId:taskId:uuid), so sanitize everywhere.
    const safeSessionId = sessionId.replace(/:/g, '-');
    const worktreePath = join(worktreesDir, safeSessionId);
    let branchName = customBranchName || `session/${safeSessionId}`;

    try {
      // Check if worktree already exists (shouldn't happen, but safety check)
      if (existsSync(worktreePath)) {
        throw new Error(`Worktree directory already exists: ${worktreePath}`);
      }

      // Check if branch already exists — this can happen when a prior task/session
      // crashed mid-run and left behind a stale branch whose worktree was already
      // removed. Delete the stale branch so we can recreate it fresh with the
      // same (intended) name instead of falling back to an opaque UUID-based name.
      const branchExists = await this.checkBranchExists(gitRoot, branchName);
      if (branchExists) {
        this.logger.warn(`Stale branch detected: ${branchName} — deleting and recreating`);
        try {
          await git.branch(['-D', branchName]);
        } catch {
          // git refuses -D when the branch is currently checked out in another
          // living worktree.  Fall back to a unique session-scoped name so the
          // task can still proceed rather than blocking entirely.
          this.logger.warn(
            `Could not delete branch ${branchName} (may be checked out in another worktree) — falling back to session/${safeSessionId}`
          );
          branchName = `session/${safeSessionId}`;
        }
      }

      // Create worktree with new branch
      await git.raw(['worktree', 'add', worktreePath, '-b', branchName, baseBranch]);

      // Initialize git submodules in the new worktree (no-op if no submodules)
      try {
        const worktreeGit = this.getGit(worktreePath);
        await worktreeGit.raw(['submodule', 'update', '--init', '--recursive']);
        /* v8 ignore next 2 */
      } catch {
        // Submodule initialization failed, but this is non-fatal
      }

      return {
        isWorktree: true,
        worktreePath,
        mainRepoPath: gitRoot,
        branch: branchName,
      };
    } catch (error) {
      this.logger.error(' Failed to create worktree:', error);

      // Try to clean up if worktree directory was created
      if (existsSync(worktreePath)) {
        try {
          await git.raw(['worktree', 'remove', worktreePath, '--force']);
        } catch (cleanupError) {
          this.logger.error(' Failed to clean up worktree:', cleanupError);
        }
      }

      throw new Error(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Remove a worktree and optionally delete its branch
   */
  async removeWorktree(worktree: WorktreeMetadata, deleteBranch = true): Promise<void> {
    const { worktreePath, mainRepoPath, branch } = worktree;

    const git = this.getGit(mainRepoPath);

    try {
      // Check if worktree still exists in git's worktree list
      const worktrees = await this.listWorktrees(mainRepoPath);
      const exists = worktrees.some((w) => w.path === worktreePath);

      if (exists) {
        // --force flag handles uncommitted changes
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
      }

      // Delete branch (auto-delete strategy as specified)
      if (deleteBranch && branch) {
        try {
          // -D force deletes even if not merged
          await git.branch(['-D', branch]);
        } catch {
          // Branch might not exist or already deleted
        }
      }
    } catch (error) {
      this.logger.error(' Failed to remove worktree:', error);
      throw new Error(
        `Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all worktrees for a repository
   */
  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const gitRoot = await this.findGitRoot(repoPath);
    if (!gitRoot) {
      return [];
    }

    const git = this.getGit(gitRoot);

    try {
      // Use --porcelain for machine-readable output
      const output = await git.raw(['worktree', 'list', '--porcelain']);
      return this.parseWorktreeList(output);
    } catch (error) {
      this.logger.error(' Failed to list worktrees:', error);
      return [];
    }
  }

  /**
   * Parse output from `git worktree list --porcelain`
   */
  private parseWorktreeList(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const lines = output.trim().split('\n');

    let currentWorktree: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        // Start of new worktree entry
        if (currentWorktree.path) {
          worktrees.push(currentWorktree as WorktreeInfo);
        }
        currentWorktree = {
          path: line.substring('worktree '.length),
          branch: '',
          commit: '',
          isPrunable: false,
        };
      } else if (line.startsWith('HEAD ')) {
        currentWorktree.commit = line.substring('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        currentWorktree.branch = line.substring('branch '.length).replace('refs/heads/', '');
      } else if (line === 'prunable') {
        currentWorktree.isPrunable = true;
      } else if (line === '') {
        // Empty line separates worktrees
        if (currentWorktree.path) {
          worktrees.push(currentWorktree as WorktreeInfo);
          currentWorktree = {};
        }
      }
    }

    // Add last worktree if exists
    if (currentWorktree.path) {
      worktrees.push(currentWorktree as WorktreeInfo);
    }

    return worktrees;
  }

  /**
   * Cleanup orphaned worktrees (manual cleanup as specified)
   * This should be called manually via a command, not automatically
   *
   * Returns array of cleaned up worktree paths
   */
  async cleanupOrphanedWorktrees(repoPath: string): Promise<string[]> {
    const gitRoot = await this.findGitRoot(repoPath);
    if (!gitRoot) {
      return [];
    }

    const git = this.getGit(gitRoot);
    const cleaned: string[] = [];

    try {
      // Prune removes worktree information for directories that no longer exist
      await git.raw(['worktree', 'prune', '--verbose']);

      // List remaining worktrees and check for prunable ones
      const worktrees = await this.listWorktrees(gitRoot);

      for (const worktree of worktrees) {
        // Skip main worktree
        if (worktree.path === gitRoot) {
          continue;
        }

        // Check if worktree is prunable (directory missing) or if it's a session worktree that doesn't exist
        // Support session worktrees (both production .hyperneo/projects and test directories)
        const testBaseDir = process.env.TEST_WORKTREE_BASE_DIR;
        const isSessionWorktree = testBaseDir
          ? worktree.path.startsWith(testBaseDir)
          : worktree.path.includes('.hyperneo/projects');

        if (worktree.isPrunable || (!existsSync(worktree.path) && isSessionWorktree)) {
          try {
            await git.raw(['worktree', 'remove', worktree.path, '--force']);
            cleaned.push(worktree.path);

            // Also try to delete the branch if it's a managed branch (session/ or task/)
            if (worktree.branch.startsWith('session/') || worktree.branch.startsWith('task/')) {
              try {
                await git.branch(['-D', worktree.branch]);
              } catch {
                // Could not delete branch, but this is non-fatal
              }
            }
          } catch (error) {
            this.logger.error(
              `[WorktreeManager] Failed to remove worktree ${worktree.path}:`,
              error
            );
          }
        }
      }
      return cleaned;
    } catch (error) {
      this.logger.error(' Failed to cleanup orphaned worktrees:', error);
      throw new Error(
        `Failed to cleanup: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Verify that a worktree is valid and accessible
   */
  async verifyWorktree(worktree: WorktreeMetadata): Promise<boolean> {
    const { worktreePath, mainRepoPath } = worktree;

    // Check if directory exists
    if (!existsSync(worktreePath)) {
      return false;
    }

    // Check if it's still in git's worktree list
    const worktrees = await this.listWorktrees(mainRepoPath);
    const exists = worktrees.some((w) => w.path === worktreePath);

    if (!exists) {
      return false;
    }

    return true;
  }

  /**
   * Get the current branch name for a worktree
   */
  async getCurrentBranch(worktreePath: string): Promise<string | null> {
    const git = simpleGit(worktreePath);

    try {
      // Works for normal repos and returns empty string for unborn HEAD.
      const branch = (await git.raw(['branch', '--show-current'])).trim();
      if (branch) {
        return branch;
      }
      return null;
    } catch {
      // Fallback for older git variants.
      try {
        const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        return branch && branch !== 'HEAD' ? branch : null;
      } catch {
        return null;
      }
    }
  }

  /**
   * Rename a branch (works even when branch is checked out in a worktree)
   * Can be called from root repo or from within the worktree itself
   *
   * @param repoPath - Path to the git repository (root or worktree)
   * @param oldBranch - Current branch name
   * @param newBranch - New branch name
   * @returns true if rename succeeded, false otherwise
   */
  async renameBranch(repoPath: string, oldBranch: string, newBranch: string): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);

      // Check if new branch name already exists
      const branchExists = await this.checkBranchExists(repoPath, newBranch);
      if (branchExists) {
        return false;
      }

      await git.branch(['-m', oldBranch, newBranch]);
      return true;
    } catch (error) {
      this.logger.error('Failed to rename branch:', error);
      return false;
    }
  }

  /**
   * Get the default branch of the repository
   * Uses symbolic-ref to get the branch that HEAD points to on the remote
   */
  private async getDefaultBranch(repoPath: string): Promise<string> {
    const git = this.getGit(repoPath);

    try {
      // Try to get the default branch from origin/HEAD
      const defaultBranch = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
      // Returns "origin/main" or "origin/master", extract just the branch name
      const branchName = defaultBranch.trim().replace('origin/', '');
      if (branchName) {
        return branchName;
      }
    } catch {
      // origin/HEAD not set, continue to fallback
    }

    // Fallback: try common branch names
    try {
      await git.revparse(['--verify', 'main']);
      return 'main';
    } catch {
      try {
        await git.revparse(['--verify', 'master']);
        return 'master';
      } catch {
        // Ultimate fallback
        return 'HEAD';
      }
    }
  }

  /**
   * Detect the current branch of the repository
   * Returns the branch that HEAD is currently on
   * @private
   */
  private async detectCurrentBranch(repoPath: string): Promise<string> {
    const git = this.getGit(repoPath);

    try {
      const currentBranch = (await git.raw(['branch', '--show-current'])).trim();
      if (currentBranch) {
        return currentBranch;
      }
    } catch {
      // Error getting current branch, fall through to default
    }

    // Fallback to default branch
    return await this.getDefaultBranch(repoPath);
  }

  /**
   * Get the base branch to compare against for commit checking
   * Strategy:
   * 1. If main repo is on a session branch, use dev/develop/main/master as the base
   * 2. If main repo is on dev/develop, use that as the base
   * 3. Otherwise prefer main/master over current branch
   */
  private async getBaseBranch(repoPath: string): Promise<string> {
    const git = this.getGit(repoPath);
    const currentBranch = await this.detectCurrentBranch(repoPath);

    // If current branch is a session branch, look for a development branch to use as base
    if (currentBranch.startsWith('session/')) {
      // Try common development branches in order
      const devBranches = ['dev', 'develop', 'development', 'main', 'master'];
      for (const branch of devBranches) {
        try {
          await git.revparse(['--verify', branch]);
          return branch;
        } catch {
          // Branch doesn't exist, continue
        }
      }
    }

    // If current branch is dev/develop, use it (this is the integration branch)
    if (['dev', 'develop', 'development'].includes(currentBranch)) {
      return currentBranch;
    }

    // Try to use main or master if they exist (preferred for production workflows)
    for (const preferredBranch of ['main', 'master']) {
      try {
        await git.revparse(['--verify', preferredBranch]);
        return preferredBranch;
      } catch {
        // Branch doesn't exist, continue
      }
    }

    // Fallback to current branch
    return currentBranch;
  }

  /**
   * Check if a commit is an ancestor of a branch
   * Returns true if the commit is reachable from the branch
   *
   * Uses git merge-base to determine ancestry:
   * If git merge-base(branch, commit) returns commit, then commit is an ancestor of branch
   */
  private async isCommitAncestor(
    repoPath: string,
    commitHash: string,
    branch: string
  ): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      // Get the merge base between the branch and the commit
      const mergeBase = (await git.raw(['merge-base', branch, commitHash])).trim();

      // If merge base equals the commit hash, the commit is an ancestor of the branch
      // (The merge base is the best common ancestor; if it's the commit itself,
      // then the commit is reachable from the branch)
      return mergeBase === commitHash || mergeBase.startsWith(commitHash);
    } catch {
      // On error, assume not an ancestor (safe default)
      return false;
    }
  }

  /**
   * Check if worktree branch has commits ahead of the base branch
   * Returns commit information for user confirmation before archiving
   */
  async getCommitsAhead(
    worktree: WorktreeMetadata,
    baseBranch?: string
  ): Promise<WorktreeCommitStatus> {
    const { mainRepoPath, branch } = worktree;

    try {
      const git = this.getGit(mainRepoPath);

      // Verify the worktree branch exists
      try {
        await git.revparse(['--verify', branch]);
      } catch {
        // Branch doesn't exist yet - no commits ahead
        const defaultBranch = await this.getDefaultBranch(mainRepoPath);
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: baseBranch || defaultBranch,
        };
      }

      // Auto-detect base branch
      // Prefer main/master for production branches, fallback to current branch for dev branches
      let base = baseBranch;
      if (!base) {
        base = await this.getBaseBranch(mainRepoPath);
      }

      // Verify base branch exists
      try {
        await git.revparse(['--verify', base]);
      } catch {
        // Base branch doesn't exist - this is an edge case
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: base,
        };
      }

      // Check if session branch's changes are already on base (handles squash merges)
      // Get the merge base to understand what files the session branch changed
      const mergeBase = (await git.raw(['merge-base', base, branch])).trim();

      // Get files modified by the session branch (from merge-base)
      const sessionChangedFiles = await git.raw(['diff', '--name-only', mergeBase, branch]);
      const changedFiles = sessionChangedFiles.trim().split('\n').filter(Boolean);

      if (changedFiles.length === 0) {
        // No files changed by session branch
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: base,
        };
      }

      // For each file the session branch changed, check if it matches base
      // If session branch's version matches base's version, the changes are already on base
      let hasUniqueChanges = false;
      for (const file of changedFiles) {
        try {
          // Compare the file content between session branch and base
          const diff = await git.raw(['diff', `${branch}:${file}`, `${base}:${file}`]);
          if (diff.trim()) {
            // File differs - session has changes not on base
            hasUniqueChanges = true;
            break;
          }
        } catch {
          // File might not exist on one side - that's a real difference
          hasUniqueChanges = true;
          break;
        }
      }

      if (!hasUniqueChanges) {
        // All files match - changes already on base (squash merged)
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: base,
        };
      }

      // Get commits: format as hash|author|date|message
      const logFormat = '--format=%H|%an|%ai|%s';
      const logOutput = await git.raw(['log', `${base}..${branch}`, logFormat]);

      // Parse commits and store both full hash and display info
      const commits: Array<{ fullHash: string; info: CommitInfo }> = [];
      if (logOutput.trim()) {
        for (const line of logOutput.trim().split('\n')) {
          const [fullHash, author, date, ...messageParts] = line.split('|');
          commits.push({
            fullHash,
            info: {
              hash: fullHash.substring(0, 7), // Short hash for display
              author,
              date,
              message: messageParts.join('|'),
            },
          });
        }
      }

      // Filter out commits already reachable from base via merge commits
      const unmergedCommits: CommitInfo[] = [];

      for (const commit of commits) {
        const isAncestor = await this.isCommitAncestor(mainRepoPath, commit.fullHash, base);

        if (!isAncestor) {
          unmergedCommits.push(commit.info);
        }
      }

      return {
        hasCommitsAhead: unmergedCommits.length > 0,
        commits: unmergedCommits,
        baseBranch: base,
      };
    } catch (error) {
      throw new Error(
        `Failed to check commits: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
