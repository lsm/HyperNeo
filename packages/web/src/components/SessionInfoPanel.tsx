import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  ChatMessage,
  Session,
  SessionFeatures,
  GitSessionStatusResponse,
} from '@hyperneo/shared';
import { DEFAULT_WORKER_FEATURES, normalizeThinkingLevel } from '@hyperneo/shared';
import { extractBackgroundTasks, type BackgroundTask } from '../hooks/useRunningToolUseIds.ts';
import { getGitSessionStatus } from '../lib/api-helpers.ts';
import { connectionState } from '../lib/state';
import { cn } from '../lib/utils.ts';
import { IconButton } from './ui/IconButton.tsx';
import { InfoRow, InfoSection } from './ui/InfoRow.tsx';

interface SessionInfoPanelButtonProps {
  session: Session | null;
  features?: SessionFeatures;
  onToolsClick: () => void;
  onExportClick: () => void;
  onResetClick: () => void;
  onArchiveClick: () => void;
  onDeleteClick: () => void;
  archiving?: boolean;
  resettingAgent?: boolean;
  readonly?: boolean;
  messages: ChatMessage[];
  backgroundTaskMessages?: ChatMessage[];
  toolInputsMap: Map<string, unknown>;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface SessionTodo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

interface SourceItem {
  id: string;
  label: string;
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function basename(path: string | null | undefined): string {
  if (!path) return 'None';
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function asTodoStatus(value: unknown): TodoStatus {
  if (value === 'completed' || value === 'in_progress' || value === 'pending') return value;
  return 'pending';
}

function truncate(value: string, maxLength = 48): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

/**
 * Compute SDK project directory path from workspace path.
 * SDK replaces both / and . with - (e.g., /.hyperneo/ -> --hyperneo-).
 */
export function getSDKProjectDir(workspacePath: string | null): string | undefined {
  if (!workspacePath) return undefined;
  const projectKey = workspacePath.replace(/[/.]/g, '-');
  return `~/.claude/projects/${projectKey}`;
}

/** Format a date string for display, falling back to the raw string on failure. */
export function formatDate(dateString: string | undefined): string | undefined {
  if (!dateString) return undefined;
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return dateString;
  }
}

/** Format cost as USD. Returns undefined for zero/missing cost so the row drops out. */
export function formatCost(cost: number | undefined): string | undefined {
  if (cost === undefined || cost === 0) return undefined;
  return `$${cost.toFixed(4)}`;
}

/** Format token count with commas. Returns undefined for zero/missing counts. */
export function formatTokens(tokens: number | undefined): string | undefined {
  if (tokens === undefined || tokens === 0) return undefined;
  return tokens.toLocaleString();
}

function getToolUseBlocks(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record.type !== 'assistant' || !isRecord(record.message)) continue;
    const content = record.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      blocks.push(block);
    }
  }
  return blocks;
}

function extractLatestTodos(messages: ChatMessage[]): SessionTodo[] {
  const toolUseBlocks = getToolUseBlocks(messages);

  for (let i = toolUseBlocks.length - 1; i >= 0; i--) {
    const block = toolUseBlocks[i];
    if (block.name !== 'TodoWrite' || !isRecord(block.input)) continue;
    const todos = block.input.todos;
    if (!Array.isArray(todos)) continue;

    return todos
      .map((todo): SessionTodo | null => {
        if (!isRecord(todo)) return null;
        const content = getString(todo, 'content');
        if (!content) return null;
        return {
          content,
          status: asTodoStatus(todo.status),
          activeForm: getString(todo, 'activeForm'),
        };
      })
      .filter((todo): todo is SessionTodo => todo !== null);
  }

  return [];
}

function extractSources(messages: ChatMessage[]): SourceItem[] {
  const sources = new Map<string, SourceItem>();

  for (const block of getToolUseBlocks(messages)) {
    if (!isRecord(block.input)) continue;
    const name = getString(block, 'name');
    let source: SourceItem | null = null;

    if (name === 'Read') {
      const path = getString(block.input, 'file_path');
      if (path) source = { id: `read:${path}`, label: basename(path), detail: path };
    } else if (name === 'ReadMcpResourceTool') {
      const uri = getString(block.input, 'uri');
      if (uri) source = { id: `mcp:${uri}`, label: basename(uri), detail: uri };
    } else if (name === 'WebFetch') {
      const url = getString(block.input, 'url');
      if (url) source = { id: `web:${url}`, label: url, detail: 'Web' };
    } else if (name === 'WebSearch') {
      const query = getString(block.input, 'query');
      if (query) source = { id: `search:${query}`, label: query, detail: 'Search' };
    }

    if (source) {
      sources.delete(source.id);
      sources.set(source.id, source);
    }
  }

  return [...sources.values()].slice(-5).reverse();
}

function StatusDot({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    return (
      <span class="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300">
        <svg class="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke-width={2} stroke-linecap="round" />
        </svg>
      </span>
    );
  }

  return (
    <span
      class={cn(
        'h-4 w-4 rounded-full border',
        status === 'in_progress'
          ? 'animate-pulse border-gray-300 bg-gray-300/10'
          : 'border-gray-500'
      )}
    />
  );
}

function PanelSection({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <section class="border-b border-white/10 py-4 first:pt-0 last:border-b-0 last:pb-0">
      <h3 class="mb-3 text-sm font-medium text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

function PanelRow({
  icon,
  label,
  value,
  tone = 'default',
}: {
  icon: preact.ComponentChildren;
  label: string;
  value?: string;
  tone?: 'default' | 'success' | 'danger' | 'muted';
}) {
  return (
    <div class="flex min-w-0 items-center gap-3 py-1.5">
      <span
        class={cn(
          'flex h-5 w-5 flex-shrink-0 items-center justify-center',
          tone === 'success'
            ? 'text-emerald-300'
            : tone === 'danger'
              ? 'text-red-300'
              : 'text-gray-300'
        )}
      >
        {icon}
      </span>
      <span class="min-w-0 flex-1 truncate text-sm text-gray-100">{label}</span>
      {value && <span class="flex-shrink-0 text-sm text-gray-500">{value}</span>}
    </div>
  );
}

function GitRows({ session, open }: { session: Session | null; open: boolean }) {
  const [status, setStatus] = useState<GitSessionStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (!open || !sessionId) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);

    getGitSessionStatus(sessionId)
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Git status unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  if (!session) {
    return <p class="text-sm text-gray-500">No session selected.</p>;
  }

  if (loading && !status) {
    return <p class="text-sm text-gray-500">Loading Git status...</p>;
  }

  if (error) {
    return (
      <PanelRow
        icon={<ErrorIcon />}
        label="Git status unavailable"
        value={truncate(error, 28)}
        tone="danger"
      />
    );
  }

  if (!status || status.mode === 'none') {
    return <p class="text-sm text-gray-500">No Git workspace.</p>;
  }

  const changedFiles = status.files.length;
  const clean = changedFiles === 0;
  const modeLabel = status.mode === 'worktree' ? 'Worktree' : 'Local';
  const branchLabel = status.branch
    ? status.baseBranch
      ? `${status.branch} -> ${status.baseBranch}`
      : status.branch
    : 'Detached';

  return (
    <div>
      <PanelRow
        icon={<ChangesIcon />}
        label="Changes"
        value={clean ? 'Clean' : `${changedFiles} file${changedFiles === 1 ? '' : 's'}`}
        tone={clean ? 'muted' : 'success'}
      />
      <PanelRow
        icon={<WorkspaceIcon />}
        label={modeLabel}
        value={basename(status.worktreePath ?? status.workspacePath)}
      />
      <PanelRow icon={<BranchIcon />} label={truncate(branchLabel, 32)} />
      <PanelRow
        icon={<CommitIcon />}
        label="Commits"
        value={
          status.aheadCount === null
            ? undefined
            : `${status.aheadCount} ahead${status.behindCount ? `, ${status.behindCount} behind` : ''}`
        }
      />
      {status.error && <PanelRow icon={<ErrorIcon />} label={status.error} tone="danger" />}
    </div>
  );
}

function ProgressRows({ todos }: { todos: SessionTodo[] }) {
  if (todos.length === 0) {
    return <p class="text-sm text-gray-500">No progress yet.</p>;
  }

  return (
    <div class="space-y-2">
      {todos.map((todo, index) => (
        <div key={`${todo.status}:${todo.content}:${index}`} class="flex min-w-0 items-start gap-3">
          <span class="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <StatusDot status={todo.status} />
          </span>
          <div class="min-w-0 flex-1">
            <div
              class={cn(
                'text-sm leading-snug',
                todo.status === 'completed' ? 'text-gray-500 line-through' : 'text-gray-200'
              )}
            >
              {todo.content}
            </div>
            {todo.status === 'in_progress' && todo.activeForm && (
              <div class="mt-0.5 text-xs text-gray-500">{todo.activeForm}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BackgroundTaskRows({ tasks }: { tasks: BackgroundTask[] }) {
  if (tasks.length === 0) {
    return <p class="text-sm text-gray-500">No background tasks.</p>;
  }

  return (
    <div>
      {tasks.map((task) => (
        <PanelRow
          key={task.id}
          icon={<TerminalIcon />}
          label={truncate(task.label, 42)}
          value={task.status === 'running' ? undefined : task.status}
        />
      ))}
    </div>
  );
}

function SourceRows({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) {
    return <p class="text-sm text-gray-500">No sources yet.</p>;
  }

  return (
    <div class="space-y-1">
      {sources.map((source) => (
        <div key={source.id} class="min-w-0 rounded-md px-1 py-1">
          <div class="truncate text-sm text-gray-200">{source.label}</div>
          {source.detail && <div class="truncate text-xs text-gray-600">{source.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function ActionToolbar({
  features,
  isConnected,
  archiving,
  resettingAgent,
  readonly,
  archived,
  onToolsClick,
  onExportClick,
  onResetClick,
  onArchiveClick,
  onDeleteClick,
}: {
  features: SessionFeatures;
  isConnected: boolean;
  archiving: boolean;
  resettingAgent: boolean;
  readonly: boolean;
  archived: boolean;
  onToolsClick: () => void;
  onExportClick: () => void;
  onResetClick: () => void;
  onArchiveClick: () => void;
  onDeleteClick: () => void;
}) {
  return (
    <div
      class="flex flex-wrap items-center gap-1 border-b border-white/10 pb-3"
      data-testid="session-info-toolbar"
    >
      {!readonly && (
        <IconButton size="sm" title="Tools" onClick={onToolsClick}>
          <ToolsIcon />
        </IconButton>
      )}
      <IconButton size="sm" title="Export chat" onClick={onExportClick} disabled={!isConnected}>
        <ExportIcon />
      </IconButton>
      <IconButton
        size="sm"
        title={resettingAgent ? 'Resetting agent...' : 'Reset agent'}
        onClick={onResetClick}
        disabled={resettingAgent || !isConnected}
      >
        {resettingAgent ? <SpinnerIcon /> : <ResetIcon />}
      </IconButton>
      {features.archive && (
        <>
          <IconButton
            size="sm"
            title={archiving ? 'Archiving...' : 'Archive session'}
            onClick={onArchiveClick}
            disabled={archiving || archived || !isConnected}
          >
            {archiving ? <SpinnerIcon /> : <ArchiveIcon />}
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            title="Delete chat"
            onClick={onDeleteClick}
            disabled={!isConnected}
          >
            <DeleteIcon />
          </IconButton>
        </>
      )}
    </div>
  );
}

function MetadataSections({ session }: { session: Session }) {
  const sdkProjectDir = getSDKProjectDir(session.workspacePath);
  const { metadata, worktree, config } = session;

  return (
    <>
      <InfoSection title="Basic">
        <InfoRow label="Session ID" value={session.id} />
        <InfoRow label="Title" value={session.title} />
        <InfoRow label="Status" value={session.status} />
        <InfoRow label="Created" value={formatDate(session.createdAt)} />
        <InfoRow label="Last Active" value={formatDate(session.lastActiveAt)} />
        {session.archivedAt && <InfoRow label="Archived" value={formatDate(session.archivedAt)} />}
      </InfoSection>

      <InfoSection title="Workspace">
        <InfoRow label="Workspace Path" value={session.workspacePath ?? undefined} />
        <InfoRow label="SDK Folder" value={sdkProjectDir} />
        <InfoRow label="SDK Session ID" value={session.sdkSessionId} />
        {session.gitBranch && <InfoRow label="Git Branch" value={session.gitBranch} />}
      </InfoSection>

      {worktree && (
        <InfoSection title="Worktree">
          <InfoRow label="Worktree Path" value={worktree.worktreePath} />
          <InfoRow label="Main Repo" value={worktree.mainRepoPath} />
          <InfoRow label="Branch" value={worktree.branch} />
        </InfoSection>
      )}

      <InfoSection title="Configuration">
        <InfoRow label="Model" value={config?.model} />
        <InfoRow label="Provider" value={config?.provider || 'anthropic'} />
        <InfoRow
          label="Thinking Level"
          value={normalizeThinkingLevel(config?.thinkingLevel) || 'off'}
        />
        <InfoRow label="Query Mode" value={config?.queryMode || 'immediate'} />
        <InfoRow label="Permission Mode" value={config?.permissionMode || 'default'} />
      </InfoSection>

      <InfoSection title="Usage">
        <InfoRow label="Messages" value={metadata?.messageCount?.toString()} />
        <InfoRow label="Total Tokens" value={formatTokens(metadata?.totalTokens)} />
        <InfoRow label="Input Tokens" value={formatTokens(metadata?.inputTokens)} />
        <InfoRow label="Output Tokens" value={formatTokens(metadata?.outputTokens)} />
        <InfoRow label="Tool Calls" value={metadata?.toolCallCount?.toString()} />
        <InfoRow label="Total Cost" value={formatCost(metadata?.totalCost)} />
      </InfoSection>
    </>
  );
}

function InternalDetails({ session }: { session: Session }) {
  const { metadata } = session;

  return (
    <details class="group border-t border-white/10 pt-3" data-testid="session-info-internal">
      <summary class="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500 transition-colors hover:text-gray-300 [&::-webkit-details-marker]:hidden">
        <ChevronIcon />
        Internal
      </summary>
      <div class="mt-2 space-y-1">
        <InfoRow label="Title Generated" value={metadata?.titleGenerated ? 'Yes' : 'No'} />
        <InfoRow
          label="Workspace Initialized"
          value={metadata?.workspaceInitialized ? 'Yes' : 'No'}
        />
        {session.availableCommands && session.availableCommands.length > 0 && (
          <InfoRow label="Available Commands" value={session.availableCommands.join(', ')} />
        )}
      </div>
    </details>
  );
}

export function SessionInfoPanelButton({
  session,
  features = DEFAULT_WORKER_FEATURES,
  onToolsClick,
  onExportClick,
  onResetClick,
  onArchiveClick,
  onDeleteClick,
  archiving = false,
  resettingAgent = false,
  readonly = false,
  messages = [],
  backgroundTaskMessages = [],
  toolInputsMap = new Map(),
}: SessionInfoPanelButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const todos = useMemo(() => extractLatestTodos(messages), [messages]);
  const tasks = useMemo(
    () => extractBackgroundTasks(backgroundTaskMessages, toolInputsMap),
    [backgroundTaskMessages, toolInputsMap]
  );
  const sources = useMemo(() => extractSources(messages), [messages]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const isConnected = connectionState.value === 'connected';
  const archived = session?.status === 'archived';

  return (
    <div ref={rootRef} class="relative">
      <IconButton
        title="Session info"
        onClick={() => setOpen((value) => !value)}
        class={cn('flex-shrink-0 text-gray-400', open && 'bg-white/10 text-gray-100')}
      >
        <InfoIcon />
      </IconButton>

      {open && (
        <div
          data-testid="session-info-panel"
          class="absolute right-0 top-[calc(100%+10px)] z-50 w-[calc(100vw-1.5rem)] max-w-[380px] max-h-[calc(100dvh-140px)] md:max-h-[calc(100dvh-78px)] overflow-y-auto rounded-[22px] border border-white/10 bg-dark-800/95 p-5 shadow-2xl shadow-black/40 backdrop-blur-xl"
        >
          <ActionToolbar
            features={features}
            isConnected={isConnected}
            archiving={archiving}
            resettingAgent={resettingAgent}
            readonly={readonly}
            archived={archived}
            onToolsClick={onToolsClick}
            onExportClick={onExportClick}
            onResetClick={onResetClick}
            onArchiveClick={onArchiveClick}
            onDeleteClick={onDeleteClick}
          />

          {features.sessionInfo && (
            <>
              <PanelSection title="Progress">
                <ProgressRows todos={todos} />
              </PanelSection>

              <PanelSection title="Git">
                <GitRows session={session} open={open} />
              </PanelSection>

              <PanelSection title="Background tasks">
                <BackgroundTaskRows tasks={tasks} />
              </PanelSection>

              <PanelSection title="Sources">
                <SourceRows sources={sources} />
              </PanelSection>

              {session && (
                <div class="pt-4">
                  <MetadataSections session={session} />
                  <InternalDetails session={session} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function InfoIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.9}
        d="M12 11.5v5M12 7.25h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

function ToolsIcon() {
  return (
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
      />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
      />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width={4} />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      class="h-3 w-3 transition-transform group-open:rotate-90"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ChangesIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="M12 5v14M5 12h14M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z"
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

function BranchIcon() {
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

function TerminalIcon() {
  return (
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={1.8}
        d="m7 8 4 4-4 4M13 16h4M5.5 5.5h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"
      />
    </svg>
  );
}
