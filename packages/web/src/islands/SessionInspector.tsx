import type { ChatMessage, Session } from '@hyperneo/shared';
import { normalizeThinkingLevel } from '@hyperneo/shared';
import { useMemo, useState } from 'preact/hooks';
import { GitPanel } from '../components/GitPanel.tsx';
import { RenameIcon } from '../components/icons/RenameIcon.tsx';
import { IconButton } from '../components/ui/IconButton.tsx';
import { InfoRow, InfoSection } from '../components/ui/InfoRow.tsx';
import { extractBackgroundTasks, type BackgroundTask } from '../hooks/useRunningToolUseIds.ts';
import { useSessionRename } from '../hooks/useSessionRename.ts';
import { navigateToSpaceAgent } from '../lib/router.ts';
import { sessionStore } from '../lib/session-store.ts';
import { conversationTitle } from '../lib/session-sidebar-status.ts';
import type { InspectorSection } from '../lib/signals.ts';
import { rightPanelTargetSignal } from '../lib/signals.ts';
import { spaceStore } from '../lib/space-store.ts';
import { connectionState } from '../lib/state.ts';
import { cn } from '../lib/utils.ts';

export interface ProgressItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

const SECTIONS: Array<{ key: InspectorSection; label: string }> = [
  { key: 'session', label: 'Conversation' },
  { key: 'work', label: 'Work' },
  { key: 'changes', label: 'Changes' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function formatDate(dateString: string | undefined): string | undefined {
  if (!dateString) return undefined;
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return dateString;
  }
}

export function extractLatestTodos(messages: ChatMessage[]): ProgressItem[] {
  for (let m = messages.length - 1; m >= 0; m--) {
    const record = messages[m] as unknown as Record<string, unknown>;
    if (record.type !== 'assistant' || !isRecord(record.message)) continue;
    const content = record.message.content;
    if (!Array.isArray(content)) continue;
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b];
      if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'TodoWrite') continue;
      const todos =
        isRecord(block.input) && Array.isArray(block.input.todos) ? block.input.todos : [];
      return todos.flatMap((todo, index) => {
        if (!isRecord(todo) || typeof todo.content !== 'string' || !todo.content.trim()) return [];
        const status =
          todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending';
        return [
          {
            id: `todo:${index}`,
            content: todo.content,
            status,
            ...(typeof todo.activeForm === 'string' && todo.activeForm
              ? { activeForm: todo.activeForm }
              : {}),
          },
        ];
      });
    }
  }
  return [];
}

export function collectToolInputs(messages: ChatMessage[]): Map<string, unknown> {
  const inputs = new Map<string, unknown>();
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record.type !== 'assistant' || !isRecord(record.message)) continue;
    const content = record.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
        inputs.set(block.id, block.input);
      }
    }
  }
  return inputs;
}

function StatusDot({ status }: { status: ProgressItem['status'] }) {
  if (status === 'completed') {
    return (
      <span class="flex h-4 w-4 items-center justify-center rounded-full bg-success/20 text-success-soft">
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
        status === 'in_progress' ? 'animate-pulse border-fg-soft bg-fill' : 'border-fg-faint'
      )}
    />
  );
}

function ProgressRows({ items }: { items: ProgressItem[] }) {
  if (items.length === 0) return <p class="text-sm text-fg-faint">No progress yet.</p>;
  return (
    <div class="space-y-2" data-testid="inspector-progress">
      {items.map((item) => (
        <div key={item.id} class="flex min-w-0 items-start gap-3">
          <span class="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <StatusDot status={item.status} />
          </span>
          <div class="min-w-0 flex-1">
            <div
              class={cn(
                'text-sm leading-snug',
                item.status === 'completed' ? 'text-fg-faint line-through' : 'text-fg-soft'
              )}
            >
              {item.content}
            </div>
            {item.status === 'in_progress' && item.activeForm && (
              <div class="mt-0.5 text-xs text-fg-faint">{item.activeForm}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BackgroundTaskRows({ tasks }: { tasks: BackgroundTask[] }) {
  if (tasks.length === 0) return <p class="text-sm text-fg-faint">No background tasks.</p>;
  return (
    <div class="space-y-1" data-testid="inspector-background-tasks">
      {tasks.map((task) => (
        <div key={task.id} class="flex min-w-0 items-center gap-3 py-1">
          <span class="min-w-0 flex-1 truncate text-sm text-fg">{task.label}</span>
          {task.status !== 'running' && (
            <span class="flex-shrink-0 text-xs text-fg-faint">{task.status}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <section class="border-b border-line py-4 first:pt-0 last:border-b-0">
      <h3 class="mb-3 text-sm font-medium text-fg-faint">{title}</h3>
      {children}
    </section>
  );
}

function SessionSection({ session, readonly }: { session: Session; readonly: boolean }) {
  const agent = spaceStore.agents.value.find((candidate) => candidate.sessionId === session.id);
  const { isEditing, startEditing, inputProps } = useSessionRename(session.id, session.title ?? '');
  const isConnected = connectionState.value === 'connected';
  const spaceSlug = spaceStore.space.value?.slug ?? null;

  if (agent) {
    return (
      <div data-testid="inspector-agent-card">
        <Section title="Agent">
          <InfoRow label="Name" value={agent.displayName} />
          <InfoRow label="Handle" value={`@${agent.handle}`} />
          <InfoRow label="Status" value={agent.status} />
          {agent.autonomyLevel && <InfoRow label="Autonomy" value={`L${agent.autonomyLevel}`} />}
          {agent.model && <InfoRow label="Model" value={agent.model} />}
          {agent.thinkingLevel && <InfoRow label="Thinking" value={agent.thinkingLevel} />}
          {spaceSlug && (
            <button
              type="button"
              class="mt-3 rounded-md border border-line px-3 py-1.5 text-xs text-fg-soft transition hover:bg-fill hover:text-fg"
              onClick={() => {
                rightPanelTargetSignal.value = null;
                navigateToSpaceAgent(spaceSlug);
              }}
              data-testid="inspector-open-agent"
            >
              Agent settings
            </button>
          )}
        </Section>
        {agent.instructions && (
          <Section title="Instructions">
            <p class="whitespace-pre-wrap text-sm text-fg-soft">{agent.instructions}</p>
          </Section>
        )}
      </div>
    );
  }

  return (
    <div data-testid="inspector-session-card">
      <Section title="Conversation">
        <div class="mb-2 flex items-center gap-2">
          {isEditing ? (
            <input
              {...inputProps}
              data-testid="inspector-rename-input"
              placeholder="Conversation title"
              class="min-w-0 flex-1 rounded-md border border-line-strong bg-surface/80 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-fg-faint"
            />
          ) : (
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {conversationTitle(
                session.title || 'Untitled conversation',
                !!session.parentSessionId
              )}
            </span>
          )}
          {!readonly && !isEditing && (
            <IconButton
              size="sm"
              title="Rename conversation"
              onClick={startEditing}
              disabled={!isConnected}
            >
              <RenameIcon className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        <InfoRow label="Status" value={session.status} />
        <InfoRow label="Created" value={formatDate(session.createdAt)} />
        <InfoRow label="Last active" value={formatDate(session.lastActiveAt)} />
      </Section>
      <InfoSection title="Model">
        <InfoRow label="Model" value={session.config?.model} />
        <InfoRow label="Provider" value={session.config?.provider || 'anthropic'} />
        <InfoRow
          label="Thinking"
          value={normalizeThinkingLevel(session.config?.thinkingLevel) || 'off'}
        />
      </InfoSection>
      <InfoSection title="Workspace">
        <InfoRow label="Path" value={session.workspacePath ?? undefined} />
        {session.worktree && <InfoRow label="Worktree" value={session.worktree.worktreePath} />}
        {(session.worktree?.branch || session.gitBranch) && (
          <InfoRow label="Branch" value={session.worktree?.branch ?? session.gitBranch} />
        )}
      </InfoSection>
    </div>
  );
}

function WorkSection({ session }: { session: Session }) {
  const messages = sessionStore.sdkMessages.value;
  const backgroundMessages = sessionStore.backgroundTaskMessages.value;
  const recorded = (session.metadata as { progress?: { items?: ProgressItem[] } } | undefined)
    ?.progress?.items;
  const items = useMemo(() => recorded ?? extractLatestTodos(messages), [recorded, messages]);
  const tasks = useMemo(
    () => extractBackgroundTasks(backgroundMessages, collectToolInputs(messages)),
    [backgroundMessages, messages]
  );
  return (
    <>
      <Section title="Progress">
        <ProgressRows items={items} />
      </Section>
      <Section title="Background tasks">
        <BackgroundTaskRows tasks={tasks} />
      </Section>
    </>
  );
}

export function SessionInspector({
  sessionId,
  section: initialSection = 'session',
}: {
  sessionId: string;
  section?: InspectorSection;
}) {
  const [section, setSection] = useState<InspectorSection>(initialSection);
  const info = sessionStore.sessionInfo.value;
  const session = info?.id === sessionId ? info : null;
  const readonly = session?.status === 'archived';
  const hasWorkspace = Boolean(session?.workspacePath || session?.worktree);

  return (
    <div class="flex h-full min-w-0 flex-col overflow-hidden" data-testid="session-inspector">
      <div class="flex h-[52px] flex-shrink-0 items-center gap-1 border-b border-line px-3 pr-12">
        {SECTIONS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={section === entry.key}
            onClick={() => setSection(entry.key)}
            disabled={entry.key === 'changes' && !hasWorkspace}
            class={cn(
              'rounded-md px-3 py-1.5 text-sm transition disabled:opacity-40',
              section === entry.key
                ? 'bg-fill text-fg'
                : 'text-fg-muted hover:bg-fill-soft hover:text-fg'
            )}
            data-testid={`inspector-tab-${entry.key}`}
          >
            {entry.label}
          </button>
        ))}
        <IconButton
          title="Close inspector"
          class="ml-auto"
          onClick={() => {
            rightPanelTargetSignal.value = null;
          }}
          data-testid="inspector-close"
        >
          <svg
            class="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width={2}
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </IconButton>
      </div>
      {section === 'changes' ? (
        <GitPanel sessionId={sessionId} />
      ) : !session ? (
        <p class="px-5 py-4 text-sm text-fg-faint">Loading conversation…</p>
      ) : (
        <div class="flex-1 overflow-y-auto px-5 py-4">
          {section === 'session' ? (
            <SessionSection session={session} readonly={readonly} />
          ) : (
            <WorkSection session={session} />
          )}
        </div>
      )}
    </div>
  );
}
