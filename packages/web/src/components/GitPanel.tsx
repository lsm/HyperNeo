import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  GitCheckSummary,
  GitFileStatusKind,
  GitPullRequestSummary,
  GitReviewFile,
  GitReviewSummary,
  GitSessionStatusResponse,
} from '@hyperneo/shared';
import { getGitFileDiff } from '../lib/api-helpers.ts';
import { useGitSessionStatus } from '../hooks/useGitSessionStatus.ts';
import { copyToClipboard } from '../lib/utils.ts';
import { cn } from '../lib/utils.ts';
import { InspectPanel } from './ui/InspectPanel.tsx';

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

type FileBucket = 'staged' | 'unstaged' | 'committed';

const BUCKET_LABELS: Record<FileBucket, string> = {
  staged: 'Staged',
  unstaged: 'Unstaged',
  committed: 'On branch',
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

function editorFileUri(root: string | null, relPath: string): string | null {
  if (!root || !relPath) return null;
  const isWindows = /^([A-Za-z]:[\\/]|[\\/]{2})/.test(root);
  const norm = (p: string) => (isWindows ? p.replace(/\\/g, '/') : p);
  const abs = `${norm(root.replace(/[\\/]+$/, ''))}/${norm(relPath)}`;
  const encoded = abs.split('/').map(encodeURIComponent).join('/');
  return `vscode://file/${encoded.replace(/^\//, '')}`;
}

function hashString(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
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

function fileBuckets(
  file: GitReviewFile,
  stagedByPath: Map<string, boolean>,
  unstagedByPath: Map<string, boolean>
): FileBucket[] {
  if (stagedByPath.has(file.path)) {
    const buckets: FileBucket[] = [];
    if (stagedByPath.get(file.path)) buckets.push('staged');
    if (unstagedByPath.get(file.path)) buckets.push('unstaged');
    return buckets.length > 0 ? buckets : ['unstaged'];
  }
  return ['committed'];
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-400/10 text-emerald-200';
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-red-400/10 text-red-200';
  if (line.startsWith('@@')) return 'text-sky-300';
  if (line.startsWith('diff --git')) return 'text-gray-300';
  return 'text-gray-500';
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
    <section class="flex-shrink-0 border-b border-white/10 px-4 py-4">
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
        <AheadBehindRow ahead={status.aheadCount} behind={status.behindCount} />
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

function AheadBehindRow({ ahead, behind }: { ahead: number | null; behind: number | null }) {
  if (ahead === null) return null;
  const tone = behind ? 'pending' : 'success';
  const label =
    behind && behind > 0
      ? `${ahead} ahead · ${behind} behind`
      : `${ahead} ahead${ahead === 1 ? '' : ' commits'}`;
  return <SummaryRow icon={<CommitIcon />} label={label} tone={tone} />;
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
  const [open, setOpen] = useState(false);

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
  const tone = failed ? 'danger' : pending ? 'pending' : 'success';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        class="flex w-full min-w-0 items-center gap-3 rounded-md text-sm text-gray-200 transition-colors hover:text-gray-100"
        aria-expanded={open}
        data-testid="git-checks-toggle"
      >
        <span
          class={cn(
            'flex h-5 w-5 flex-shrink-0 items-center justify-center',
            tone === 'danger'
              ? 'text-red-300'
              : tone === 'pending'
                ? 'text-amber-300'
                : 'text-emerald-300'
          )}
        >
          {failed ? <ErrorIcon /> : pending ? <PendingIcon /> : <ChecksIcon />}
        </span>
        <span class="min-w-0 flex-1 truncate text-left">{label}</span>
        <span class="flex-shrink-0 text-xs text-gray-500">{checks.length} total</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <ul class="mt-1 max-h-60 space-y-0.5 overflow-y-auto pl-8" data-testid="git-checks-list">
          {checks.map((check) => (
            <CheckItem key={`${check.name}:${check.state}:${check.url ?? ''}`} check={check} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CheckItem({ check }: { check: GitCheckSummary }) {
  const bucket = checkBucket(check);
  const toneClass =
    bucket === 'pass'
      ? 'text-emerald-300'
      : bucket === 'fail'
        ? 'text-red-300'
        : bucket === 'pending'
          ? 'text-amber-300'
          : 'text-gray-500';

  const inner = (
    <>
      <span class={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center', toneClass)}>
        {bucket === 'pass' ? (
          <CheckDotIcon />
        ) : bucket === 'fail' ? (
          <ErrorIcon />
        ) : bucket === 'pending' ? (
          <PendingIcon />
        ) : (
          <DotIcon />
        )}
      </span>
      <span class="min-w-0 flex-1 truncate text-gray-300">{check.name}</span>
      <span class="flex-shrink-0 text-[11px] capitalize text-gray-600">{check.state}</span>
    </>
  );

  const className = 'flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-white/5';

  if (check.url) {
    return (
      <li>
        <a
          href={check.url}
          target="_blank"
          rel="noreferrer"
          class={cn(className, 'text-gray-400 hover:text-gray-200')}
          title={`Open CI run: ${check.url}`}
        >
          {inner}
        </a>
      </li>
    );
  }
  return <li class={cn(className, 'text-gray-500')}>{inner}</li>;
}

function FileList({
  files,
  stagedByPath,
  selectedPath,
  onSelect,
  repoRootPath,
  unstagedByPath,
}: {
  files: GitReviewFile[];
  stagedByPath: Map<string, boolean>;
  unstagedByPath: Map<string, boolean>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  repoRootPath: string | null;
}) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? files.filter((file) => file.path.toLowerCase().includes(normalized))
    : files;

  const hasWorktree = stagedByPath.size > 0;
  const groups: FileBucket[] = ['staged', 'unstaged', 'committed'];
  const grouped = groups
    .map((bucket) => ({
      bucket,
      items: filtered.filter((file) =>
        fileBuckets(file, stagedByPath, unstagedByPath).includes(bucket)
      ),
    }))
    .filter((group) => group.items.length > 0);
  const renderGrouped = hasWorktree && grouped.length > 1;

  return (
    <section class="flex min-h-0 flex-1 flex-col border-b border-white/10 px-3 py-3">
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
        <>
          <input
            type="search"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter files…"
            class="mb-2 w-full rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-gray-200 placeholder:text-gray-600 focus:border-white/20 focus:outline-none"
            data-testid="git-file-search"
          />
          {filtered.length === 0 ? (
            <p class="px-1 py-3 text-xs text-gray-600">No files match “{query}”.</p>
          ) : (
            <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {(renderGrouped ? grouped : [{ bucket: null, items: filtered }]).map((group) => (
                <div key={group.bucket ?? 'all'}>
                  {group.bucket && (
                    <div class="sticky top-0 z-10 bg-dark-800/90 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-gray-600 backdrop-blur">
                      {BUCKET_LABELS[group.bucket]} · {group.items.length}
                    </div>
                  )}
                  {group.items.map((file) => (
                    <FileRow
                      key={`${group.bucket ?? 'all'}:${file.path}`}
                      file={file}
                      selected={selectedPath === file.path}
                      onSelect={onSelect}
                      repoRootPath={repoRootPath}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
  repoRootPath,
}: {
  file: GitReviewFile;
  selected: boolean;
  onSelect: (path: string) => void;
  repoRootPath: string | null;
}) {
  const editorHref = file.status === 'deleted' ? null : editorFileUri(repoRootPath, file.path);

  return (
    <div
      class={cn(
        'group flex w-full min-w-0 items-center gap-1 rounded-md px-1 text-left text-xs transition-colors',
        selected ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:bg-white/5'
      )}
      title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
    >
      <button
        type="button"
        onClick={() => onSelect(file.path)}
        class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5"
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
      <CopyPathButton path={file.path} />
      {editorHref && (
        <a
          href={editorHref}
          target="_blank"
          rel="noreferrer"
          title="Open in editor (VS Code)"
          aria-label={`Open ${file.path} in editor`}
          class="flex-shrink-0 rounded p-1 text-gray-600 opacity-0 transition-opacity hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
        >
          <ExternalLinkIcon />
        </a>
      )}
    </div>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (event: Event) => {
    event.stopPropagation();
    const ok = await copyToClipboard(path);
    setCopied(ok);
    if (ok) {
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy path"
      aria-label={`Copy path ${path}`}
      data-testid="git-copy-path"
      class="flex-shrink-0 rounded p-1 text-gray-600 opacity-0 transition-opacity hover:bg-white/10 hover:text-gray-200 group-hover:opacity-100"
    >
      {copied ? <CheckSmallIcon /> : <CopyIcon />}
    </button>
  );
}

function DiffLines({ patch }: { patch: string }) {
  const lines = patch.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <div key={`${index}:${line.slice(0, 24)}`} class={cn('font-mono', diffLineClass(line))}>
          {line || ' '}
        </div>
      ))}
    </>
  );
}

function DiffPreview({ file, sessionId }: { file: GitReviewFile | null; sessionId: string }) {
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [fullPatch, setFullPatch] = useState<string | null>(null);
  const [fullTruncated, setFullTruncated] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const expandSeq = useRef(0);

  const fileKey = file
    ? `${file.path} ${file.additions} ${file.deletions} ${file.patchTruncated} ${hashString(file.patch ?? '')}`
    : null;

  useEffect(() => {
    expandSeq.current++;
    setExpandedPath(null);
    setFullPatch(null);
    setFullTruncated(false);
    setExpandError(null);
    setLoadingFull(false);
  }, [fileKey]);

  if (!file) {
    return (
      <section class="flex min-h-0 flex-[1.5] items-center justify-center px-6 text-center">
        <p class="text-sm text-gray-500">Select a changed file to review its diff.</p>
      </section>
    );
  }

  const isExpanded = expandedPath === file.path;
  const shownPatch = isExpanded ? fullPatch : file.patch;

  const handleExpand = async () => {
    const requestId = ++expandSeq.current;
    setLoadingFull(true);
    setExpandError(null);
    try {
      const result = await getGitFileDiff(sessionId, file.path);
      if (requestId !== expandSeq.current) return;
      if (result.error) {
        setExpandError(result.error);
        return;
      }
      setFullPatch(result.patch);
      setFullTruncated(result.truncated);
      setExpandedPath(file.path);
    } catch (err) {
      if (requestId !== expandSeq.current) return;
      setExpandError(err instanceof Error ? err.message : 'Failed to load full diff');
    } finally {
      if (requestId === expandSeq.current) setLoadingFull(false);
    }
  };

  return (
    <section class="flex min-h-0 flex-[1.5] flex-col">
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

      {shownPatch ? (
        <div class="min-h-0 flex-1 overflow-auto bg-dark-900/50">
          <pre class="min-w-max p-3 text-[11px] leading-relaxed">
            <DiffLines patch={shownPatch} />
            {!isExpanded && file.patchTruncated && (
              <div class="pt-2">
                <button
                  type="button"
                  onClick={handleExpand}
                  disabled={loadingFull}
                  class="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-gray-300 transition-colors hover:bg-white/10 hover:text-gray-100 disabled:opacity-50"
                  data-testid="git-expand-diff"
                >
                  {loadingFull ? 'Loading…' : 'Expand full diff'}
                </button>
                <p class="mt-1 font-mono text-amber-300/80">Diff truncated for panel preview.</p>
              </div>
            )}
            {isExpanded && fullTruncated && (
              <div class="pt-2 font-mono text-amber-300/80">Full diff still truncated.</div>
            )}
            {expandError && <div class="pt-2 font-mono text-red-300">{expandError}</div>}
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
  const stagedByPath = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const file of status.files) map.set(file.path, file.staged);
    return map;
  }, [status.files]);
  const unstagedByPath = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const file of status.files) map.set(file.path, file.unstaged);
    return map;
  }, [status.files]);
  const repoRootPath = status.gitRoot ?? status.worktreePath ?? status.mainRepoPath;

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
      <FileList
        files={review.files}
        stagedByPath={stagedByPath}
        unstagedByPath={unstagedByPath}
        selectedPath={selectedPath}
        onSelect={setSelectedPath}
        repoRootPath={repoRootPath}
      />
      <DiffPreview file={selectedFile} sessionId={status.sessionId} />
      {status.error && (
        <p class="flex-shrink-0 border-t border-white/10 bg-red-500/10 px-4 py-2 text-xs leading-relaxed text-red-300">
          {status.error}
        </p>
      )}
    </div>
  );
}

export function GitPanel({ sessionId }: GitPanelProps) {
  const { status, loading, error, refresh } = useGitSessionStatus(sessionId);

  const header = (
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
  );

  const body =
    loading && !status ? (
      <div class="flex-1 px-4 py-4">
        <div class="space-y-3">
          <div class="h-20 rounded-lg bg-white/[0.03] animate-pulse" />
          <div class="h-36 rounded-lg bg-white/[0.03] animate-pulse" />
          <div class="h-44 rounded-lg bg-white/[0.03] animate-pulse" />
        </div>
      </div>
    ) : status ? (
      <>
        {error && (
          <p
            data-testid="git-status-error-banner"
            class="flex-shrink-0 border-b border-white/10 bg-amber-500/10 px-4 py-2 text-xs leading-relaxed text-amber-300"
          >
            Couldn't refresh: {error}. Showing the last known status.
          </p>
        )}
        <GitPanelBody status={status} />
      </>
    ) : error ? (
      <EmptyState title="Git status unavailable" body={error} />
    ) : null;

  return <InspectPanel header={header}>{body}</InspectPanel>;
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

function CommitIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M4 12h6M14 12h6M10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"
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

function CheckDotIcon() {
  return (
    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2.5}
        d="M4.5 12.75 10 18.25 19.5 6.5"
      />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <circle cx="12" cy="12" r="3.5" stroke-width={2.5} />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      class={cn('h-3 w-3 flex-shrink-0 text-gray-600 transition-transform', open && 'rotate-90')}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M8 8H6.5A1.5 1.5 0 0 0 5 9.5v8A1.5 1.5 0 0 0 6.5 19h8a1.5 1.5 0 0 0 1.5-1.5V16M9.5 5h8A1.5 1.5 0 0 1 19 6.5v8A1.5 1.5 0 0 1 17.5 16h-8A1.5 1.5 0 0 1 8 14.5v-8A1.5 1.5 0 0 1 9.5 5Z"
      />
    </svg>
  );
}

function CheckSmallIcon() {
  return (
    <svg class="h-3.5 w-3.5 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2.5}
        d="M4.5 12.75 10 18.25 19.5 6.5"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M14 5h5v5M19 5l-8 8M12 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
      />
    </svg>
  );
}
