import simpleGit, { SimpleGit } from 'simple-git';
import { execFile } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { worktreeDeclaresLfsAttributes } from './worktree-lfs.ts';
import type {
  WorktreeMetadata,
  CommitInfo,
  WorktreeCommitStatus,
  GitBranchesResponse,
  GitChangedFile,
  GitReviewFile,
  GitReviewSummary,
  GitCheckSummary,
  GitPullRequestSummary,
  GitSessionStatusResponse,
  GitFileDiffResponse,
  Session,
} from '@hyperneo/shared';
import { Logger } from './logger.ts';
import { getProjectShortKey, getWorktreeBaseDir } from './worktree-path-utils.ts';
import { gitStatusKind, parseNumstatMap, parsePorcelainStatus } from './worktree-git-output.ts';
import { buildGitCommandEnv, buildGitSshEnv } from './spawn-env.ts';
import { buildGitHubLookupEnv } from './space/runtime/gh-lookup-helpers.ts';

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isPrunable: boolean;
}

export interface CreateWorktreeOptions {
  sessionId: string;
  repoPath: string;
  branchName?: string;
  baseBranch?: string;
}

const MAX_REVIEW_FILES = 80;
const MAX_PATCH_CHARS = 24_000;
const MAX_FULL_PATCH_CHARS = 1_000_000;
const GH_TIMEOUT_MS = 8_000;

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

async function hydrateLfsObjects(git: SimpleGit, worktreePath: string): Promise<void> {
  let tracked: string;
  try {
    tracked = await git.raw(['lfs', 'ls-files']);
  } catch (err) {
    if (await worktreeDeclaresLfsAttributes(worktreePath, () => git.raw(['ls-files']))) {
      throw new Error(
        `Repository tracks Git LFS files but 'git lfs ls-files' failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return;
  }
  if (tracked.trim().length > 0) {
    await git.raw(['lfs', 'pull']);
  }
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

  private getGit(repoPath: string): SimpleGit {
    if (!this.gitCache.has(repoPath)) {
      this.gitCache.set(repoPath, simpleGit(repoPath).env(buildGitCommandEnv()));
    }
    return this.gitCache.get(repoPath)!;
  }

  async findGitRoot(path: string): Promise<string | null> {
    try {
      let currentPath = normalize(path);
      const root = dirname(currentPath);

      while (currentPath !== root) {
        if (existsSync(join(currentPath, '.git'))) {
          const git = this.getGit(currentPath);
          await git.revparse(['--git-dir']);
          return currentPath;
        }
        currentPath = dirname(currentPath);
      }

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
      currentBranch = summary.current ? summary.current : null;
    } catch (error) {
      this.logger.warn(`getRepoGitInfo: failed to list branches for ${gitRoot}:`, error);
    }

    let defaultBranch: string | null = null;
    try {
      const detected = await this.getDefaultBranch(gitRoot);
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
    if (!effectivePath || !path || !path.trim()) return empty;

    const repoInfo = await this.getRepoGitInfo(effectivePath);
    if (!repoInfo.isGitRepo || !repoInfo.gitRoot) {
      return { ...empty, error: 'Not a git repository' };
    }

    const git = this.getGit(repoInfo.gitRoot);
    const branch = session.worktree?.branch ?? repoInfo.currentBranch ?? session.gitBranch ?? null;

    let baseBranch = repoInfo.defaultBranch;
    if (session.worktree) {
      try {
        const commitStatus = await this.getCommitsAhead(session.worktree);
        baseBranch = commitStatus.baseBranch;
      } catch {}
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

    let worktreeResult: { patch: string | null; truncated: boolean } = {
      patch: null,
      truncated: false,
    };
    let isUntracked = false;
    try {
      const files = await this.getChangedFiles(repoInfo.gitRoot);
      const file = files.find((entry) => entry.path === path);
      if (file?.status === 'untracked') isUntracked = true;
    } catch {}
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
      } catch {}
    }

    return {
      sessionId: session.id,
      path: path,
      patch: combined.patch,
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
        status: gitStatusKind(statusLetter, ' '),
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
    try {
      const args = ['diff', '--numstat', ...rangeArgs];
      if (pathspec) args.push('--', pathspec);
      const output = await git.raw(args);
      return parseNumstatMap(output);
    } catch {
      return new Map();
    }
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
        {
          cwd,
          encoding: 'utf8',
          timeout: GH_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          env: buildGitHubLookupEnv(),
        },
        (error, stdout, stderr) => {
          const output = typeof stdout === 'string' ? stdout.trim() : '';
          if (output) {
            try {
              resolve({ ok: true, data: JSON.parse(output) });
              return;
            } catch {}
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
    return parsePorcelainStatus(output);
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

  private async checkBranchExists(repoPath: string, branchName: string): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      const result = await git.raw(['branch', '--list', branchName]);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async resolveMainRepoPath(worktreePath: string): Promise<string | null> {
    try {
      const git = this.getGit(worktreePath);

      const gitDir = await git.revparse(['--path-format=absolute', '--git-dir']);

      if (!gitDir) {
        return null;
      }

      const worktreesMatch = gitDir.match(/^(.+?\.git)[/\\]worktrees[/\\]/);

      if (worktreesMatch) {
        const mainGitDir = worktreesMatch[1];
        return dirname(mainGitDir);
      }

      return this.findGitRoot(worktreePath);
    } catch (error) {
      this.logger.warn(`resolveMainRepoPath failed for ${worktreePath}:`, error);
      return null;
    }
  }

  public getProjectShortKey(repoPath: string): string {
    return getProjectShortKey(repoPath);
  }

  private getWorktreeBaseDir(gitRoot: string): string {
    return getWorktreeBaseDir(gitRoot, (msg) => this.logger.warn(msg));
  }

  async createWorktree(options: CreateWorktreeOptions): Promise<WorktreeMetadata | null> {
    const { sessionId, repoPath, branchName: customBranchName, baseBranch = 'HEAD' } = options;

    const gitRoot = await this.findGitRoot(repoPath);
    if (!gitRoot) {
      this.logger.warn(`createWorktree: no git root found for repoPath=${repoPath}`);
      return null;
    }

    const git = this.getGit(gitRoot);

    const worktreesDir = this.getWorktreeBaseDir(gitRoot);
    if (!existsSync(worktreesDir)) {
      mkdirSync(worktreesDir, { recursive: true });
    }

    const safeSessionId = sessionId.replace(/:/g, '-');
    const worktreePath = join(worktreesDir, safeSessionId);
    let branchName = customBranchName || `session/${safeSessionId}`;
    let branchProvisioned = false;

    try {
      if (existsSync(worktreePath)) {
        throw new Error(`Worktree directory already exists: ${worktreePath}`);
      }

      const branchExists = await this.checkBranchExists(gitRoot, branchName);
      if (branchExists) {
        this.logger.warn(`Stale branch detected: ${branchName} — deleting and recreating`);
        try {
          await git.branch(['-D', branchName]);
        } catch {
          this.logger.warn(
            `Could not delete branch ${branchName} (may be checked out in another worktree) — falling back to session/${safeSessionId}`
          );
          branchName = `session/${safeSessionId}`;
        }
      }

      const worktreeAddGit = simpleGit(gitRoot).env({
        ...buildGitCommandEnv(),
        GIT_LFS_SKIP_SMUDGE: '1',
      });
      await worktreeAddGit.raw(['worktree', 'add', worktreePath, '-b', branchName, baseBranch]);
      branchProvisioned = true;

      const networkGit = simpleGit(worktreePath, { timeout: { block: 300_000 } }).env(
        buildGitSshEnv()
      );
      try {
        await networkGit.raw(['submodule', 'update', '--init', '--recursive']);
        /* v8 ignore next 2 */
      } catch {}
      await hydrateLfsObjects(networkGit, worktreePath);

      return {
        isWorktree: true,
        worktreePath,
        mainRepoPath: gitRoot,
        branch: branchName,
      };
    } catch (error) {
      this.logger.error(' Failed to create worktree:', error);

      if (existsSync(worktreePath)) {
        try {
          await git.raw(['worktree', 'remove', worktreePath, '--force']);
        } catch (cleanupError) {
          this.logger.error(' Failed to clean up worktree:', cleanupError);
        }
      }

      if (branchProvisioned) {
        try {
          await git.branch(['-D', branchName]);
        } catch {}
      }

      throw new Error(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async removeWorktree(worktree: WorktreeMetadata, deleteBranch = true): Promise<void> {
    const { worktreePath, mainRepoPath, branch } = worktree;

    const git = this.getGit(mainRepoPath);

    try {
      const worktrees = await this.listWorktrees(mainRepoPath);
      const exists = worktrees.some((w) => w.path === worktreePath);

      if (exists) {
        await git.raw(['worktree', 'remove', worktreePath, '--force']);
      }

      if (deleteBranch && branch) {
        try {
          await git.branch(['-D', branch]);
        } catch {}
      }
    } catch (error) {
      this.logger.error(' Failed to remove worktree:', error);
      throw new Error(
        `Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const gitRoot = await this.findGitRoot(repoPath);
    if (!gitRoot) {
      return [];
    }

    const git = this.getGit(gitRoot);

    try {
      const output = await git.raw(['worktree', 'list', '--porcelain']);
      return this.parseWorktreeList(output);
    } catch (error) {
      this.logger.error(' Failed to list worktrees:', error);
      return [];
    }
  }

  private parseWorktreeList(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const lines = output.trim().split('\n');

    let currentWorktree: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
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
        if (currentWorktree.path) {
          worktrees.push(currentWorktree as WorktreeInfo);
          currentWorktree = {};
        }
      }
    }

    if (currentWorktree.path) {
      worktrees.push(currentWorktree as WorktreeInfo);
    }

    return worktrees;
  }

  async cleanupOrphanedWorktrees(repoPath: string): Promise<string[]> {
    const gitRoot = await this.findGitRoot(repoPath);
    if (!gitRoot) {
      return [];
    }

    const git = this.getGit(gitRoot);
    const cleaned: string[] = [];

    try {
      await git.raw(['worktree', 'prune', '--verbose']);

      const worktrees = await this.listWorktrees(gitRoot);

      for (const worktree of worktrees) {
        if (worktree.path === gitRoot) {
          continue;
        }

        const testBaseDir = process.env.TEST_WORKTREE_BASE_DIR;
        const isSessionWorktree = testBaseDir
          ? worktree.path.startsWith(testBaseDir)
          : worktree.path.includes('.hyperneo/projects');

        if (worktree.isPrunable || (!existsSync(worktree.path) && isSessionWorktree)) {
          try {
            await git.raw(['worktree', 'remove', worktree.path, '--force']);
            cleaned.push(worktree.path);

            if (worktree.branch.startsWith('session/') || worktree.branch.startsWith('task/')) {
              try {
                await git.branch(['-D', worktree.branch]);
              } catch {}
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

  async verifyWorktree(worktree: WorktreeMetadata): Promise<boolean> {
    const { worktreePath, mainRepoPath } = worktree;

    if (!existsSync(worktreePath)) {
      return false;
    }

    const worktrees = await this.listWorktrees(mainRepoPath);
    const exists = worktrees.some((w) => w.path === worktreePath);

    if (!exists) {
      return false;
    }

    return true;
  }

  async getCurrentBranch(worktreePath: string): Promise<string | null> {
    const git = simpleGit(worktreePath).env(buildGitCommandEnv());

    try {
      const branch = (await git.raw(['branch', '--show-current'])).trim();
      if (branch) {
        return branch;
      }
      return null;
    } catch {
      try {
        const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        return branch && branch !== 'HEAD' ? branch : null;
      } catch {
        return null;
      }
    }
  }

  async renameBranch(repoPath: string, oldBranch: string, newBranch: string): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);

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

  private async getDefaultBranch(repoPath: string): Promise<string> {
    const git = this.getGit(repoPath);

    try {
      const defaultBranch = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
      const branchName = defaultBranch.trim().replace('origin/', '');
      if (branchName) {
        return branchName;
      }
    } catch {}

    try {
      await git.revparse(['--verify', 'main']);
      return 'main';
    } catch {
      try {
        await git.revparse(['--verify', 'master']);
        return 'master';
      } catch {
        return 'HEAD';
      }
    }
  }

  private async detectCurrentBranch(repoPath: string): Promise<string> {
    const git = this.getGit(repoPath);

    try {
      const currentBranch = (await git.raw(['branch', '--show-current'])).trim();
      if (currentBranch) {
        return currentBranch;
      }
    } catch {}

    return await this.getDefaultBranch(repoPath);
  }

  private async getBaseBranch(repoPath: string): Promise<string> {
    const git = this.getGit(repoPath);
    const currentBranch = await this.detectCurrentBranch(repoPath);

    if (currentBranch.startsWith('session/')) {
      const devBranches = ['dev', 'develop', 'development', 'main', 'master'];
      for (const branch of devBranches) {
        try {
          await git.revparse(['--verify', branch]);
          return branch;
        } catch {}
      }
    }

    if (['dev', 'develop', 'development'].includes(currentBranch)) {
      return currentBranch;
    }

    for (const preferredBranch of ['main', 'master']) {
      try {
        await git.revparse(['--verify', preferredBranch]);
        return preferredBranch;
      } catch {}
    }

    return currentBranch;
  }

  private async isCommitAncestor(
    repoPath: string,
    commitHash: string,
    branch: string
  ): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      const mergeBase = (await git.raw(['merge-base', branch, commitHash])).trim();

      return mergeBase === commitHash || mergeBase.startsWith(commitHash);
    } catch {
      return false;
    }
  }

  async getCommitsAhead(
    worktree: WorktreeMetadata,
    baseBranch?: string
  ): Promise<WorktreeCommitStatus> {
    const { mainRepoPath, branch } = worktree;

    try {
      const git = this.getGit(mainRepoPath);

      try {
        await git.revparse(['--verify', branch]);
      } catch {
        const defaultBranch = await this.getDefaultBranch(mainRepoPath);
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: baseBranch || defaultBranch,
        };
      }

      let base = baseBranch;
      if (!base) {
        base = await this.getBaseBranch(mainRepoPath);
      }

      try {
        await git.revparse(['--verify', base]);
      } catch {
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: base,
        };
      }

      const mergeBase = (await git.raw(['merge-base', base, branch])).trim();

      const sessionChangedFiles = await git.raw(['diff', '--name-only', mergeBase, branch]);
      const changedFiles = sessionChangedFiles.trim().split('\n').filter(Boolean);

      if (changedFiles.length === 0) {
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: base,
        };
      }

      let hasUniqueChanges = false;
      for (const file of changedFiles) {
        try {
          const diff = await git.raw(['diff', `${branch}:${file}`, `${base}:${file}`]);
          if (diff.trim()) {
            hasUniqueChanges = true;
            break;
          }
        } catch {
          hasUniqueChanges = true;
          break;
        }
      }

      if (!hasUniqueChanges) {
        return {
          hasCommitsAhead: false,
          commits: [],
          baseBranch: base,
        };
      }

      const logFormat = '--format=%H|%an|%ai|%s';
      const logOutput = await git.raw(['log', `${base}..${branch}`, logFormat]);

      const commits: Array<{ fullHash: string; info: CommitInfo }> = [];
      if (logOutput.trim()) {
        for (const line of logOutput.trim().split('\n')) {
          const [fullHash, author, date, ...messageParts] = line.split('|');
          commits.push({
            fullHash,
            info: {
              hash: fullHash.substring(0, 7),
              author,
              date,
              message: messageParts.join('|'),
            },
          });
        }
      }

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
