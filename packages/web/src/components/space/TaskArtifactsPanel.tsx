import { useState, useEffect, useMemo } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { cn } from '../../lib/utils';
import { spaceStore } from '../../lib/space-store';
import { FileDiffView } from './FileDiffView';
import { ArtifactCard } from './ArtifactCard';
import type { WorkflowRunArtifact } from '@hyperneo/shared';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import {
  parseThreadRow,
  buildThreadEvents,
  extractFileOperations,
  buildSyntheticDiff,
  type TodoItem,
  type FileOperation,
} from './thread/space-task-thread-events';

function relativeTime(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  const diffSec = Math.floor(diffMs / 1_000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export interface TaskArtifactsPanelProps {
  runId: string;
  taskId?: string;
  onClose?: () => void;
  class?: string;
}

interface FileDiffStat {
  path: string;
  additions: number;
  deletions: number;
}

interface UncommittedResult {
  files: FileDiffStat[];
  totalAdditions: number;
  totalDeletions: number;
  isGitRepo: boolean;
}

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: number;
  additions: number;
  deletions: number;
  fileCount: number;
}

interface CommitsResult {
  commits: CommitInfo[];
  baseRef: string | null;
  isGitRepo: boolean;
  repoUrl?: string | null;
}

type PanelView =
  | { mode: 'list' }
  | { mode: 'commitFiles'; commit: CommitInfo }
  | { mode: 'fileDiff'; filePath: string; commitSha?: string; fromCommit?: CommitInfo }
  | { mode: 'syntheticDiff'; op: FileOperation };

function SectionHeader({
  label,
  meta,
  metaTestId,
}: {
  label: string;
  meta?: preact.ComponentChildren;
  metaTestId?: string;
}) {
  return (
    <div class="px-4 py-2 flex items-center justify-between border-b border-dark-800">
      <span class="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</span>
      {meta && (
        <span class="text-xs text-gray-400 font-mono" data-testid={metaTestId}>
          {meta}
        </span>
      )}
    </div>
  );
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <svg class="w-3.5 h-3.5 text-green-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clip-rule="evenodd"
        />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg
        class="w-3.5 h-3.5 text-blue-400 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    );
  }
  return (
    <svg
      class="w-3.5 h-3.5 text-gray-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <circle cx="12" cy="12" r="9" stroke-width={2} />
    </svg>
  );
}

function FileRow({ file, onClick }: { file: FileDiffStat; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      class={cn(
        'w-full flex items-center gap-3 px-3 py-2 rounded text-left',
        'hover:bg-dark-700 transition-colors group'
      )}
      data-testid="artifacts-file-row"
      data-file-path={file.path}
    >
      <svg
        class="w-3.5 h-3.5 text-gray-400 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <span
        class="flex-1 text-xs font-mono text-gray-300 truncate min-w-0 group-hover:text-gray-100"
        title={file.path}
      >
        {file.path}
      </span>
      <span class="flex-shrink-0 flex items-center gap-1.5 text-xs font-mono">
        <span class="text-green-400">+{file.additions}</span>
        <span class="text-red-400">-{file.deletions}</span>
      </span>
      <svg
        class="w-3 h-3 text-gray-400 flex-shrink-0 group-hover:text-gray-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

function CommitFilesView({
  runId,
  taskId,
  commit,
  onBack,
  onFileClick,
}: {
  runId: string;
  taskId?: string;
  commit: CommitInfo;
  onBack: () => void;
  onFileClick: (filePath: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileDiffStat[]>([]);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setError('Not connected');
      setLoading(false);
      return;
    }

    hub
      .request<{ files: FileDiffStat[] }>('spaceWorkflowRun.getCommitFiles', {
        runId,
        commitSha: commit.sha,
        ...(taskId ? { taskId } : {}),
      })
      .then((result) => {
        setFiles(result.files);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load commit files');
      })
      .finally(() => setLoading(false));
  }, [runId, taskId, commit.sha]);

  const shortSha = commit.sha.slice(0, 7);

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-dark-700 flex-shrink-0 bg-dark-850">
        <button
          onClick={onBack}
          class="text-gray-400 hover:text-gray-100 transition-colors flex-shrink-0"
          aria-label="Back"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-300 truncate">{commit.message}</p>
          <p class="text-xs text-gray-400 font-mono">{shortSha}</p>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto min-h-0">
        {loading && (
          <div class="flex items-center justify-center h-24">
            <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {error && !loading && (
          <div class="px-4 py-4">
            <p class="text-sm text-red-400">{error}</p>
          </div>
        )}
        {!loading && !error && (
          <div class="px-2 py-1 space-y-0.5">
            {files.length === 0 ? (
              <p class="px-2 py-3 text-sm text-gray-400">No files changed</p>
            ) : (
              files.map((file) => (
                <FileRow key={file.path} file={file} onClick={() => onFileClick(file.path)} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function TaskArtifactsPanel({ runId, taskId, class: className }: TaskArtifactsPanelProps) {
  const [view, setView] = useState<PanelView>({ mode: 'list' });

  const [uncommittedLoading, setUncommittedLoading] = useState(true);
  const [uncommittedError, setUncommittedError] = useState<string | null>(null);
  const [uncommitted, setUncommitted] = useState<UncommittedResult | null>(null);

  const [commitsLoading, setCommitsLoading] = useState(true);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsData, setCommitsData] = useState<CommitsResult | null>(null);

  const [artifacts, setArtifacts] = useState<WorkflowRunArtifact[]>([]);

  const { rows: messageRows, error: messageRowsError } = useSpaceTaskMessages(taskId ?? null);

  const fileOps = useMemo<FileOperation[]>(() => {
    if (!messageRows.length) return [];
    const parsedRows = messageRows.map(parseThreadRow);
    return extractFileOperations(parsedRows);
  }, [messageRows]);

  const todosByAgent = useMemo<{ label: string; todos: TodoItem[] }[]>(() => {
    if (!messageRows.length) return [];

    const bySession = new Map<string, typeof messageRows>();
    for (const row of messageRows) {
      const key = row.sessionId ?? 'unknown';
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(row);
    }

    const result: { label: string; todos: TodoItem[] }[] = [];
    for (const [, rows] of bySession) {
      const parsedRows = rows.map(parseThreadRow);
      const events = buildThreadEvents(parsedRows);
      let latestTodos: TodoItem[] | null = null;
      for (let i = events.length - 1; i >= 0; i--) {
        const t = events[i].todos;
        if (t && t.length > 0) {
          latestTodos = t;
          break;
        }
      }
      if (latestTodos) {
        const label = rows[0]?.label ?? 'Agent';
        result.push({ label, todos: latestTodos });
      }
    }
    return result;
  }, [messageRows]);

  useEffect(() => {
    setUncommittedLoading(true);
    setUncommittedError(null);
    setCommitsLoading(true);
    setCommitsError(null);

    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setUncommittedError('Not connected');
      setUncommittedLoading(false);
      setCommitsError('Not connected');
      setCommitsLoading(false);
      return;
    }

    const taskParams = taskId ? { taskId } : {};

    let cancelled = false;

    const fetchGateArtifacts = () => {
      hub
        .request<UncommittedResult>('spaceWorkflowRun.getGateArtifacts', { runId, ...taskParams })
        .then((r) => {
          if (!cancelled) setUncommitted(r);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setUncommittedError(err instanceof Error ? err.message : 'Failed to load changes');
          }
        })
        .finally(() => {
          if (!cancelled) setUncommittedLoading(false);
        });
    };

    const fetchCommits = () => {
      hub
        .request<CommitsResult>('spaceWorkflowRun.getCommits', { runId, ...taskParams })
        .then((r) => {
          if (!cancelled) setCommitsData(r);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setCommitsError(err instanceof Error ? err.message : 'Failed to load commits');
          }
        })
        .finally(() => {
          if (!cancelled) setCommitsLoading(false);
        });
    };

    fetchGateArtifacts();
    fetchCommits();

    spaceStore
      .listArtifacts(runId)
      .then((result) => {
        if (!cancelled) setArtifacts(result);
      })
      .catch(() => {});

    const unsubscribe = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      runId: string;
      taskId: string;
      cacheKey: string;
      status: 'ok' | 'syncing' | 'error';
    }>('space.artifactCache.updated', (event) => {
      if (cancelled) return;
      if (event.runId !== runId) return;
      if (taskId && event.taskId && event.taskId !== taskId) return;
      if (event.cacheKey === 'gateArtifacts') {
        fetchGateArtifacts();
      } else if (event.cacheKey === 'commits') {
        fetchCommits();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runId, taskId]);

  if (view.mode === 'syntheticDiff') {
    const synth = buildSyntheticDiff(view.op);
    return (
      <FileDiffView
        runId={runId}
        taskId={taskId}
        filePath={view.op.path}
        precomputedDiff={synth}
        onBack={() => setView({ mode: 'list' })}
        class={className}
      />
    );
  }

  if (view.mode === 'fileDiff') {
    return (
      <FileDiffView
        runId={runId}
        taskId={taskId}
        filePath={view.filePath}
        commitSha={view.commitSha}
        onBack={() =>
          view.fromCommit
            ? setView({ mode: 'commitFiles', commit: view.fromCommit })
            : setView({ mode: 'list' })
        }
        class={className}
      />
    );
  }

  if (view.mode === 'commitFiles') {
    return (
      <CommitFilesView
        runId={runId}
        taskId={taskId}
        commit={view.commit}
        onBack={() => setView({ mode: 'list' })}
        onFileClick={(filePath) =>
          setView({
            mode: 'fileDiff',
            filePath,
            commitSha: view.commit.sha,
            fromCommit: view.commit,
          })
        }
      />
    );
  }

  const isGitRepo = uncommitted?.isGitRepo !== false && commitsData?.isGitRepo !== false;

  const uncommittedMeta =
    uncommitted && uncommitted.files.length > 0 ? (
      <>
        <span class="text-green-400">+{uncommitted.totalAdditions}</span>
        <span class="text-red-400 ml-1">-{uncommitted.totalDeletions}</span>
        <span class="text-gray-400 ml-1.5">
          {uncommitted.files.length} {uncommitted.files.length === 1 ? 'file' : 'files'}
        </span>
      </>
    ) : null;

  const hasTodos = todosByAgent.length > 0;

  return (
    <div
      class={cn('flex flex-col h-full overflow-hidden', className)}
      data-testid="artifacts-panel"
    >
      <div class="flex-1 overflow-y-auto min-h-0">
        <div class="min-h-[calc(100%+1px)]">
          {hasTodos && (
            <div class="mb-2">
              <SectionHeader label="Todos" />
              <div class="py-1">
                {todosByAgent.map(({ label, todos }, agentIdx) => (
                  <div key={agentIdx}>
                    {todosByAgent.length > 1 && (
                      <p class="px-4 pt-2 pb-0.5 text-xs text-gray-400 font-medium">{label}</p>
                    )}
                    {[
                      ...todos.filter((t) => t.status === 'in_progress'),
                      ...todos.filter((t) => t.status === 'pending'),
                      ...todos.filter((t) => t.status === 'completed'),
                    ].map((todo, i) => (
                      <div key={i} class="flex items-start gap-2.5 px-4 py-1.5">
                        <div class="mt-0.5">
                          <TodoStatusIcon status={todo.status} />
                        </div>
                        <span
                          class={cn(
                            'text-xs leading-relaxed',
                            todo.status === 'completed'
                              ? 'text-gray-400 line-through'
                              : 'text-gray-300'
                          )}
                        >
                          {todo.content}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {artifacts.length > 0 && (
            <div class="mb-2">
              <SectionHeader
                label="Run Artifacts"
                meta={`${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`}
              />
              <div class="px-3 py-2 space-y-1.5" data-testid="artifacts-run-artifacts">
                {artifacts.map((a) => (
                  <ArtifactCard key={a.id} artifact={a} />
                ))}
              </div>
            </div>
          )}

          {messageRowsError && <p class="px-4 py-3 text-sm text-amber-500">{messageRowsError}</p>}

          {isGitRepo ? (
            <>
              <div class="mb-2">
                <SectionHeader
                  label="Commits"
                  meta={
                    commitsData?.commits.length
                      ? `${commitsData.commits.length} commit${commitsData.commits.length === 1 ? '' : 's'}`
                      : undefined
                  }
                />
                {commitsLoading && (
                  <div class="flex items-center justify-center h-16">
                    <div class="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {commitsError && !commitsLoading && (
                  <p class="px-4 py-3 text-sm text-red-400">{commitsError}</p>
                )}
                {!commitsLoading && !commitsError && (
                  <div class="px-2 py-1 space-y-0.5" data-testid="artifacts-commits-list">
                    {!commitsData?.commits.length ? (
                      <p class="px-2 py-3 text-sm text-gray-400">No commits yet</p>
                    ) : (
                      commitsData.commits.map((commit) => {
                        const ghCommitUrl = commitsData.repoUrl
                          ? `${commitsData.repoUrl}/commit/${commit.sha}`
                          : null;
                        const shortSha = commit.sha.slice(0, 7);
                        return (
                          <button
                            key={commit.sha}
                            onClick={() => setView({ mode: 'commitFiles', commit })}
                            class={cn(
                              'w-full flex items-start gap-3 px-3 py-2 rounded text-left',
                              'hover:bg-dark-700 transition-colors group'
                            )}
                            data-testid="artifacts-commit-row"
                          >
                            <svg
                              class="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <circle cx="12" cy="12" r="3" stroke-width={2} />
                              <path
                                stroke-linecap="round"
                                stroke-width={2}
                                d="M12 3v6m0 6v6M3 12h6m6 0h6"
                              />
                            </svg>
                            <div class="flex-1 min-w-0">
                              <p class="text-xs text-gray-300 truncate group-hover:text-gray-100">
                                {commit.message}
                              </p>
                              <p class="text-xs text-gray-400 font-mono mt-0.5 flex items-center gap-1.5 flex-wrap">
                                {ghCommitUrl ? (
                                  <a
                                    href={ghCommitUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="hover:text-blue-400 transition-colors"
                                    onClick={(e) => e.stopPropagation()}
                                    data-testid="artifacts-commit-sha-link"
                                  >
                                    {shortSha}
                                  </a>
                                ) : (
                                  <span>{shortSha}</span>
                                )}
                                {commit.author && (
                                  <span
                                    class="font-sans text-gray-400 truncate"
                                    data-testid="artifacts-commit-author"
                                  >
                                    {commit.author}
                                  </span>
                                )}
                                {commit.timestamp > 0 && (
                                  <span
                                    class="font-sans text-gray-400"
                                    data-testid="artifacts-commit-time"
                                  >
                                    {relativeTime(commit.timestamp)}
                                  </span>
                                )}
                                {commit.fileCount > 0 && (
                                  <span class="font-sans">
                                    {commit.fileCount} file{commit.fileCount === 1 ? '' : 's'}
                                  </span>
                                )}
                              </p>
                            </div>
                            <span class="flex-shrink-0 flex items-center gap-1 text-xs font-mono">
                              {commit.additions > 0 && (
                                <span class="text-green-400">+{commit.additions}</span>
                              )}
                              {commit.deletions > 0 && (
                                <span class="text-red-400">-{commit.deletions}</span>
                              )}
                            </span>
                            <svg
                              class="w-3 h-3 text-gray-400 flex-shrink-0 group-hover:text-gray-400 mt-0.5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width={2}
                                d="M9 5l7 7-7 7"
                              />
                            </svg>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <div>
                <SectionHeader
                  label="Uncommitted Changes"
                  meta={uncommittedMeta}
                  metaTestId="artifacts-summary"
                />
                {uncommittedLoading && (
                  <div class="flex items-center justify-center h-16">
                    <div class="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
                {uncommittedError && !uncommittedLoading && (
                  <p class="px-4 py-3 text-sm text-red-400" data-testid="artifacts-error">
                    {uncommittedError}
                  </p>
                )}
                {!uncommittedLoading && !uncommittedError && uncommitted && (
                  <div class="py-1" data-testid="artifacts-file-list">
                    {uncommitted.files.length === 0 ? (
                      <p class="px-4 py-3 text-sm text-gray-400" data-testid="artifacts-no-files">
                        No uncommitted changes
                      </p>
                    ) : (
                      <div class="px-2 space-y-0.5">
                        {uncommitted.files.map((file) => (
                          <FileRow
                            key={file.path}
                            file={file}
                            onClick={() => setView({ mode: 'fileDiff', filePath: file.path })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div>
              <SectionHeader
                label="Files Touched"
                meta={
                  fileOps.length ? (
                    <span class="text-gray-400">
                      {fileOps.length} file{fileOps.length === 1 ? '' : 's'} · not a git repo
                    </span>
                  ) : undefined
                }
              />
              <div class="py-1" data-testid="artifacts-file-list">
                {fileOps.length === 0 ? (
                  <p class="px-4 py-3 text-sm text-gray-400">No files written or edited yet</p>
                ) : (
                  <div class="px-2 space-y-0.5">
                    {fileOps.map((op) => {
                      const synth = buildSyntheticDiff(op);
                      return (
                        <FileRow
                          key={op.path}
                          file={{
                            path: op.path,
                            additions: synth.additions,
                            deletions: synth.deletions,
                          }}
                          onClick={() => setView({ mode: 'syntheticDiff', op })}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
