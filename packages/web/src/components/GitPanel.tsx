import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  GitCheckSummary,
  GitFileStatusKind,
  GitPullRequestSummary,
  GitReviewFile,
  GitReviewSummary,
  GitSessionStatusResponse,
} from '@hyperneo/shared';
import { getGitSessionStatus } from '../lib/api-helpers.ts';
import { cn } from '../lib/utils.ts';

interface GitPanelProps {
  sessionId: string;
}

const STATUS_BADGES: Record<GitFileStatusKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
  other: '*',
};

const STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: 'text-amber-300',
  added: 'text-emerald-300',
  deleted: 'text-red-300',
  renamed: 'text-sky-300',
  untracked: 'text-violet-300',
  conflicted: 'text-orange-300',
  other: 'text-gray-400',
};

const EMPTY_REVIEW: GitReviewSummary = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  pullRequest: null,
  checks: [],
};

function basename(path: string | null | undefined): string {
  if (!path) return 'None';
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function compactPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return `${parts[0]}/.../${parts.slice(-2).join('/')}`;
}

function fallbackReview(status: GitSessionStatusResponse): GitReviewSummary {
  if (status.review) return status.review;
  return {
    ...EMPTY_REVIEW,
    files: status.files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: 0,
      deletions: 0,
      patch: null,
      patchTruncated: false,
      source: 'working_tree',
    })),
  };
}

function modeLabel(status: GitSessionStatusResponse): string {
  if (status.mode === 'worktree') return 'Worktree';
  if (status.mode === 'direct') return 'Local';
  return 'No workspace';
}

function checkBucket(check: GitCheckSummary): 'pass' | 'fail' | 'pending' | 'other' {
  const bucket = check.bucket?.toLowerCase();
  const state = check.state.toLowerCase();
  if (bucket === 'pass') return 'pass';
  if (bucket === 'fail') return 'fail';
  if (bucket === 'pending') return 'pending';
  if (bucket) return 'other';
  if (state === 'success' || state === 'completed') return 'pass';
  if (state === 'failure' || state === 'failed' || state === 'error' || state === 'cancelled') {
    return 'fail';
  }
  if (state === 'pending' || state === 'queued' || state === 'in_progress' || state === 'waiting') {
    return 'pending';
  }
  return 'other';
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div class="flex flex-1 items-center justify-center px-6 text-center">
      <div>
        <svg
          class="mx-auto mb-3 h-10 w-10 text-gray-700"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={1.5}
            d="M6 3v7m0 0a3 3 0 100-6 3 3 0 000 6zm0 0v11m12-7V3m0 11a3 3 0 100-6 3 3 0 000 6zm0 0v7"
          />
        </svg>
        <p class="text-sm font-medium text-gray-300">{title}</p>
        <p class="mt-1 text-xs leading-relaxed text-gray-500">{body}</p>
      </div>
    </div>
  );
}

function SectionHeader({ title, value }: { title: string; value?: string }) {
  return (
    <div class="mb-2 flex items-center justify-between gap-3">
      <h3 class="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</h3>
      {value && <span class="text-xs text-gray-500">{value}</span>}
    </div>
  );
}

function ReviewSummary({
  status,
  review,
}: {
  status: GitSessionStatusResponse;
  review: GitReviewSummary;
}) {
  const pullRequest = review.pullRequest;
  const additions = pullRequest?.additions ?? review.totalAdditions;
  const deletions = pullRequest?.deletions ?? review.totalDeletions;
  const branchText = status.branch
    ? status.baseBranch
      ? `${status.branch} -> ${status.baseBranch}`
      : status.branch
    : 'Detached';

  return (
    <section class="border-b border-white/10 px-4 py-4">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="truncate text-sm font-semibold text-gray-100">Branch</h3>
            <span
              class={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                status.mode === 'worktree'
                  ? 'bg-emerald-400/10 text-emerald-300'
                  : 'bg-amber-400/10 text-amber-300'
              )}
            >
              {modeLabel(status)}
            </span>
          </div>
          <p class="mt-1 truncate text-xs text-gray-500" title={branchText}>
            {branchText}
          </p>
        </div>

        <div class="flex flex-shrink-0 items-center gap-2 font-mono text-sm">
          <span class="text-emerald-300">+{additions.toLocaleString()}</span>
          <span class="text-red-300">-{deletions.toLocaleString()}</span>
        </div>
      </div>

      <div class="mt-4 space-y-2">
        {pullRequest ? (
          <PullRequestRow pullRequest={pullRequest} />
        ) : (
          <SummaryRow icon={<PullRequestIcon />} label="No pull request found" muted />
        )}
        <ChecksRow checks={review.checks} githubError={review.githubError} />
        <SummaryRow
          icon={<WorkspaceIcon />}
          label={basename(status.worktreePath ?? status.workspacePath)}
          value={status.mode === 'worktree' ? 'Worktree' : 'Workspace'}
        />
      </div>
    </section>
  );
}

function SummaryRow({
  icon,
  label,
  value,
  muted = false,
  tone,
}: {
  icon: preact.ComponentChildren;
  label: string;
  value?: string;
  muted?: boolean;
  tone?: 'success' | 'danger' | 'pending';
}) {
  return (
    <div class="flex min-w-0 items-center gap-3 text-sm">
      <span
        class={cn(
          'flex h-5 w-5 flex-shrink-0 items-center justify-center',
          tone === 'success'
            ? 'text-emerald-300'
            : tone === 'danger'
              ? 'text-red-300'
              : tone === 'pending'
                ? 'text-amber-300'
                : 'text-gray-300'
        )}
      >
        {icon}
      </span>
      <span class={cn('min-w-0 flex-1 truncate', muted ? 'text-gray-500' : 'text-gray-200')}>
        {label}
      </span>
      {value && <span class="flex-shrink-0 text-xs text-gray-500">{value}</span>}
    </div>
  );
}

function PullRequestRow({ pullRequest }: { pullRequest: GitPullRequestSummary }) {
  const label = `PR #${pullRequest.number}`;
  const state = pullRequest.isDraft ? 'Draft' : pullRequest.state.toLowerCase();

  return (
    <a
      href={pullRequest.url || undefined}
      target="_blank"
      rel="noreferrer"
      class="flex min-w-0 items-center gap-3 rounded-md text-sm text-gray-200 hover:text-gray-100"
      title={pullRequest.title}
    >
      <span class="flex h-5 w-5 flex-shrink-0 items-center justify-center text-gray-300">
        <PullRequestIcon />
      </span>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      <span class="flex-shrink-0 text-xs capitalize text-gray-500">{state}</span>
    </a>
  );
}

function ChecksRow({ checks, githubError }: { checks: GitCheckSummary[]; githubError?: string }) {
  if (checks.length === 0) {
    return (
      <SummaryRow
        icon={<ChecksIcon />}
        label={githubError ? 'Checks unavailable' : 'No checks found'}
        muted={!githubError}
        tone={githubError ? 'pending' : undefined}
      />
    );
  }

  const failed = checks.filter((check) => checkBucket(check) === 'fail').length;
  const pending = checks.filter((check) => checkBucket(check) === 'pending').length;
  const passed = checks.filter((check) => checkBucket(check) === 'pass').length;
  const other = checks.length - failed - pending - passed;
  const label = failed
    ? `${failed} check${failed === 1 ? '' : 's'} failing`
    : pending
      ? `${pending} check${pending === 1 ? '' : 's'} pending`
      : other
        ? `${other} check${other === 1 ? '' : 's'} not passing`
        : `${passed} check${passed === 1 ? '' : 's'} passing`;

  return (
    <SummaryRow
      icon={failed ? <ErrorIcon /> : pending ? <PendingIcon /> : <ChecksIcon />}
      label={label}
      value={`${checks.length} total`}
      tone={failed ? 'danger' : pending ? 'pending' : 'success'}
    />
  );
}

function FileList({
  files,
  selectedPath,
  onSelect,
}: {
  files: GitReviewFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <section class="border-b border-white/10 px-3 py-3">
      <SectionHeader
        title="Changed files"
        value={
          files.length === 0 ? 'Clean' : `${files.length} file${files.length === 1 ? '' : 's'}`
        }
      />
      {files.length === 0 ? (
        <div class="rounded-lg bg-white/[0.03] px-3 py-4 text-sm text-gray-500">
          Working tree is clean.
        </div>
      ) : (
        <div class="max-h-72 space-y-0.5 overflow-y-auto">
          {files.map((file) => (
            <button
              type="button"
              key={file.path}
              onClick={() => onSelect(file.path)}
              class={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                selectedPath === file.path
                  ? 'bg-white/10 text-gray-100'
                  : 'text-gray-400 hover:bg-white/5'
              )}
              title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
            >
              <span class={cn('w-4 flex-shrink-0 font-mono', STATUS_COLORS[file.status])}>
                {STATUS_BADGES[file.status]}
              </span>
              <span class="min-w-0 flex-1 truncate font-mono">{compactPath(file.path)}</span>
              <span class="flex flex-shrink-0 items-center gap-1 font-mono">
                {file.additions > 0 && (
                  <span class="text-emerald-300">+{file.additions.toLocaleString()}</span>
                )}
                {file.deletions > 0 && (
                  <span class="text-red-300">-{file.deletions.toLocaleString()}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function DiffPreview({ file }: { file: GitReviewFile | null }) {
  if (!file) {
    return (
      <section class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <p class="text-sm text-gray-500">Select a changed file to review its diff.</p>
      </section>
    );
  }

  return (
    <section class="flex min-h-0 flex-1 flex-col">
      <div class="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div class="min-w-0">
          <h3 class="truncate font-mono text-xs text-gray-200" title={file.path}>
            {file.path}
          </h3>
          {file.oldPath && (
            <p class="mt-0.5 truncate font-mono text-[11px] text-gray-600">from {file.oldPath}</p>
          )}
        </div>
        <div class="flex flex-shrink-0 items-center gap-2 font-mono text-xs">
          <span class="text-emerald-300">+{file.additions.toLocaleString()}</span>
          <span class="text-red-300">-{file.deletions.toLocaleString()}</span>
        </div>
      </div>

      {file.patch ? (
        <div class="min-h-0 flex-1 overflow-auto bg-dark-900/50">
          <pre class="min-w-max p-3 text-[11px] leading-relaxed">
            {file.patch.split('\n').map((line, index) => (
              <div
                key={`${index}:${line.slice(0, 24)}`}
                class={cn(
                  'font-mono',
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'bg-emerald-400/10 text-emerald-200'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'bg-red-400/10 text-red-200'
                      : line.startsWith('@@')
                        ? 'text-sky-300'
                        : line.startsWith('diff --git')
                          ? 'text-gray-300'
                          : 'text-gray-500'
                )}
              >
                {line || ' '}
              </div>
            ))}
            {file.patchTruncated && (
              <div class="pt-2 font-mono text-amber-300">Diff truncated for panel preview.</div>
            )}
          </pre>
        </div>
      ) : (
        <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <p class="text-sm text-gray-500">
            No inline diff available for this file. This can happen for untracked or binary files.
          </p>
        </div>
      )}
    </section>
  );
}

function GitPanelBody({ status }: { status: GitSessionStatusResponse }) {
  const review = fallbackReview(status);
  const [selectedPath, setSelectedPath] = useState<string | null>(review.files[0]?.path ?? null);

  useEffect(() => {
    setSelectedPath((currentPath) => {
      if (currentPath && review.files.some((file) => file.path === currentPath)) return currentPath;
      return review.files[0]?.path ?? null;
    });
  }, [review.files]);

  const selectedFile = useMemo(
    () => review.files.find((file) => file.path === selectedPath) ?? null,
    [review.files, selectedPath]
  );

  if (status.mode === 'none') {
    return (
      <EmptyState
        title="No Git workspace"
        body="This chat was started without a project folder, so there is no repository state to show."
      />
    );
  }

  if (!status.isGitRepo) {
    return (
      <EmptyState
        title="Not a Git repository"
        body="This chat has a workspace folder, but it is not inside a Git repository."
      />
    );
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <ReviewSummary status={status} review={review} />
      <FileList files={review.files} selectedPath={selectedPath} onSelect={setSelectedPath} />
      <DiffPreview file={selectedFile} />
      {status.error && (
        <p class="flex-shrink-0 border-t border-white/10 bg-red-500/10 px-4 py-2 text-xs leading-relaxed text-red-300">
          {status.error}
        </p>
      )}
    </div>
  );
}

export function GitPanel({ sessionId }: GitPanelProps) {
  const [status, setStatus] = useState<GitSessionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const refresh = () => {
    const requestId = ++requestSeq.current;
    setLoading(true);
    setError(null);
    getGitSessionStatus(sessionId)
      .then((nextStatus) => {
        if (requestId === requestSeq.current) setStatus(nextStatus);
      })
      .catch((err) => {
        if (requestId === requestSeq.current) {
          setError(err instanceof Error ? err.message : 'Failed to load Git status');
        }
      })
      .finally(() => {
        if (requestId === requestSeq.current) setLoading(false);
      });
  };

  useEffect(() => {
    const requestId = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setStatus(null);
    getGitSessionStatus(sessionId)
      .then((nextStatus) => {
        if (requestId === requestSeq.current) setStatus(nextStatus);
      })
      .catch((err) => {
        if (requestId === requestSeq.current) {
          setError(err instanceof Error ? err.message : 'Failed to load Git status');
        }
      })
      .finally(() => {
        if (requestId === requestSeq.current) setLoading(false);
      });
    return () => {
      requestSeq.current++;
    };
  }, [sessionId]);

  return (
    <aside class="flex h-full w-full flex-shrink-0 flex-col bg-transparent">
      <div class="flex h-[52px] flex-shrink-0 items-center gap-2 px-4 pr-14">
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-semibold text-gray-100">Review</h2>
          <p class="truncate text-xs text-gray-500">
            {status?.branch ?? (loading ? 'Loading status...' : 'Session workspace')}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          class="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-100 disabled:opacity-50"
          title="Refresh review"
          aria-label="Refresh review"
        >
          <svg
            class={cn('h-4 w-4', loading && 'animate-spin')}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>

      {loading && !status ? (
        <div class="flex-1 px-4 py-4">
          <div class="space-y-3">
            <div class="h-20 rounded-lg bg-white/[0.03] animate-pulse" />
            <div class="h-36 rounded-lg bg-white/[0.03] animate-pulse" />
            <div class="h-44 rounded-lg bg-white/[0.03] animate-pulse" />
          </div>
        </div>
      ) : error ? (
        <EmptyState title="Git status unavailable" body={error} />
      ) : status ? (
        <GitPanelBody status={status} />
      ) : null}
    </aside>
  );
}

function PullRequestIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M7 5v14M17 5v3a4 4 0 0 1-4 4H7M17 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0ZM9 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM19 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"
      />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M4.5 17.5h15M6.5 6.5h11a1 1 0 0 1 1 1v8.5h-13V7.5a1 1 0 0 1 1-1Z"
      />
    </svg>
  );
}

function ChecksIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M12 8v4M12 16h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

function PendingIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M12 6v6l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}
