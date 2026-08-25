import type {
  HandoffTransition,
  NodeExecutionStatus,
  SpaceWorkerAgent,
  ThinkingLevel,
  WorkflowChannel,
  WorkflowNodeAgent,
  WorkflowNodeAgentOverride,
} from '@hyperneo/shared';
import { useCallback, useState } from 'preact/hooks';
import { cn } from '../../lib/utils';

export interface NodeDraft {
  localId: string;
  id?: string;
  name: string;
  agentId: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  customPrompt?: WorkflowNodeAgentOverride;
  replaceAgentPrompt?: boolean;
  disabledSkillIds?: string[];
  resetContextPerTurn?: boolean;
  agents?: WorkflowNodeAgent[];
  channels?: WorkflowChannel[];
  postApproval?: import('@hyperneo/shared').PostApprovalRoute;
  requirePrMerge?: boolean;
  handoffTransitions?: HandoffTransition[];
}

export function isMultiAgentNode(node: NodeDraft): boolean {
  return Array.isArray(node.agents) && node.agents.length > 1;
}

export interface ConditionDraft {
  type: 'always' | 'human' | 'condition' | 'task_result';
  expression?: string;
}

export interface AgentTaskState {
  agentName: string | null;
  status: NodeExecutionStatus;
  completionSummary?: string | null;
}

export function isNodeFullyCompleted(states: AgentTaskState[]): boolean {
  return states.length > 0 && states.every((s) => s.status === 'idle');
}

function SpinnerIcon({ title }: { title?: string }) {
  return (
    <svg
      class="w-3 h-3 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
      aria-label={title}
      data-testid="agent-status-spinner"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CheckIcon({ title }: { title?: string }) {
  return (
    <svg
      class="w-3 h-3"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-label={title}
      data-testid="agent-status-check"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function FailIcon({ title }: { title?: string }) {
  return (
    <svg
      class="w-3 h-3"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-label={title}
      data-testid="agent-status-fail"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2.5}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

export function AgentStatusIcon({ state }: { state: AgentTaskState }) {
  const summary = state.completionSummary ?? undefined;
  if (state.status === 'idle') {
    return (
      <span class="text-green-400 flex-shrink-0" title={summary ?? 'Done'}>
        <CheckIcon title={summary ?? 'Done'} />
      </span>
    );
  }
  if (state.status === 'in_progress') {
    return (
      <span class="text-blue-400 flex-shrink-0" title="In progress">
        <SpinnerIcon title="In progress" />
      </span>
    );
  }
  if (state.status === 'blocked' || state.status === 'cancelled') {
    return (
      <span class="text-red-400 flex-shrink-0" title={summary ?? state.status}>
        <FailIcon title={summary ?? state.status} />
      </span>
    );
  }
  return (
    <span
      class="w-1.5 h-1.5 rounded-full bg-gray-500 flex-shrink-0"
      title={state.status}
      data-testid="agent-status-pending"
    />
  );
}

function ChevronDown() {
  return (
    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ChevronUp() {
  return (
    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

export function extractOverrideValue(
  override: WorkflowNodeAgentOverride | string | undefined
): string {
  if (!override) return '';
  if (typeof override === 'string') return override;
  return override.value ?? '';
}

export function buildOverride(value: string): WorkflowNodeAgentOverride | undefined {
  return value.trim() ? { value } : undefined;
}

interface MultiAgentSectionProps {
  node: NodeDraft;
  agents: SpaceWorkerAgent[];
  onUpdate: (node: NodeDraft) => void;
}

function MultiAgentSection({ node, agents, onUpdate }: MultiAgentSectionProps) {
  const nodeAgents = node.agents ?? [];

  const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set());

  const toggleSlotExpanded = useCallback((role: string) => {
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }, []);

  function updateAgents(next: WorkflowNodeAgent[]) {
    onUpdate({ ...node, agents: next });
  }

  function addAgent(agentId: string) {
    if (!agentId) return;
    const agentInfo = agents.find((a) => a.id === agentId);
    const baseRole = agentInfo?.name?.trim() || agentId;
    const usedRoles = new Set(nodeAgents.map((a) => a.name));
    let role = baseRole;
    for (let i = 2; usedRoles.has(role); i++) {
      role = `${baseRole}-${i}`;
    }
    updateAgents([...nodeAgents, { agentId, name: role }]);
  }

  function removeAgent(role: string) {
    const removed = nodeAgents.find((a) => a.name === role);
    const next = nodeAgents.filter((a) => a.name !== role);
    if (next.length === 0) {
      onUpdate({
        ...node,
        agents: undefined,
        agentId: removed?.agentId ?? '',
        channels: undefined,
      });
    } else {
      updateAgents(next);
    }
  }

  function updateAgentCustomPrompt(role: string, value: string) {
    updateAgents(
      nodeAgents.map((a) => (a.name === role ? { ...a, customPrompt: buildOverride(value) } : a))
    );
  }

  function updateAgentModel(_role: string, _model: string) {}

  const availableAgents = agents;

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <label class="text-xs font-medium text-gray-400">
          Agents <span class="text-gray-400">({nodeAgents.length})</span>
        </label>
        {nodeAgents.length === 1 && (
          <button
            type="button"
            onClick={() =>
              onUpdate({
                ...node,
                agents: undefined,
                agentId: nodeAgents[0]?.agentId ?? '',
                channels: undefined,
              })
            }
            class="text-xs text-gray-400 hover:text-gray-300 transition-colors"
          >
            Switch to single
          </button>
        )}
      </div>

      <div class="space-y-1.5">
        {nodeAgents.map((sa) => {
          const agentInfo = agents.find((a) => a.id === sa.agentId);
          const hasOverrides = !!sa.customPrompt;
          const isExpanded = expandedSlots.has(sa.name);
          return (
            <div
              key={sa.name}
              class={`rounded p-2 space-y-1 border ${hasOverrides ? 'bg-amber-950/20 border-amber-700/40' : 'bg-dark-800 border-dark-600'}`}
            >
              <div class="flex items-center gap-1">
                <input
                  type="text"
                  value={sa.name}
                  onInput={(e) => {
                    const oldRole = sa.name;
                    const newRole = (e.currentTarget as HTMLInputElement).value;
                    setExpandedSlots((prev) => {
                      if (!prev.has(oldRole)) return prev;
                      const next = new Set(prev);
                      next.delete(oldRole);
                      next.add(newRole);
                      return next;
                    });
                    updateAgents(
                      nodeAgents.map((a) => (a.name === oldRole ? { ...a, name: newRole } : a))
                    );
                  }}
                  placeholder="slot role"
                  data-testid="agent-role-input"
                  class="flex-1 text-xs font-mono bg-dark-900 border border-dark-700 rounded px-1.5 py-0.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600 min-w-0"
                />
                {hasOverrides && (
                  <span class="text-xs text-amber-400 bg-amber-900/40 border border-amber-700/50 rounded px-1 py-0.5 flex-shrink-0">
                    overrides
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggleSlotExpanded(sa.name)}
                  class="text-gray-400 hover:text-gray-300 transition-colors flex-shrink-0"
                  title={isExpanded ? 'Hide overrides' : 'Edit overrides'}
                  aria-expanded={isExpanded}
                  data-testid="toggle-overrides-button"
                >
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    {isExpanded ? (
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M5 15l7-7 7 7"
                      />
                    ) : (
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M19 9l-7 7-7-7"
                      />
                    )}
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => removeAgent(sa.name)}
                  class="text-gray-400 hover:text-red-400 transition-colors flex-shrink-0"
                  title="Remove agent"
                >
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
              <p class="text-xs text-gray-400">{agentInfo?.name ?? sa.agentId ?? ''}</p>
              <div class="space-y-0.5">
                <label class="text-xs text-gray-400">Custom Prompt</label>
                <input
                  type="text"
                  value={extractOverrideValue(sa.customPrompt)}
                  onInput={(e) =>
                    updateAgentCustomPrompt(sa.name, (e.currentTarget as HTMLInputElement).value)
                  }
                  placeholder="Per-agent custom prompt (optional)…"
                  data-testid="agent-instructions-input"
                  class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700"
                />
              </div>
              {isExpanded && (
                <div class="space-y-1 pt-1 border-t border-dark-700" data-testid="slot-overrides">
                  <p class="text-xs text-gray-400 font-medium">Slot overrides</p>
                  <div class="space-y-0.5">
                    <label class="text-xs text-gray-400">Model</label>
                    <input
                      type="text"
                      value={''}
                      onInput={(e) =>
                        updateAgentModel(sa.name, (e.currentTarget as HTMLInputElement).value)
                      }
                      placeholder="e.g. claude-opus-4-6 (leave blank to use default)"
                      data-testid="agent-model-input"
                      class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-700"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {availableAgents.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            addAgent((e.currentTarget as HTMLSelectElement).value);
            (e.currentTarget as HTMLSelectElement).value = '';
          }}
          class="w-full text-xs bg-dark-800 border border-dark-600 border-dashed rounded px-2 py-1.5 text-gray-400 focus:outline-none focus:border-blue-500"
        >
          <option value="">+ Add agent…</option>
          {availableAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}

      <ChannelsSection node={node} agents={agents} onUpdate={onUpdate} />
    </div>
  );
}

interface ChannelsSectionProps {
  node: NodeDraft;
  agents: SpaceWorkerAgent[];
  onUpdate: (node: NodeDraft) => void;
}

function formatTo(to: string | string[]): string {
  return Array.isArray(to) ? `[${to.join(', ')}]` : to;
}

function ChannelsSection({ node, onUpdate }: ChannelsSectionProps) {
  const channels = node.channels ?? [];
  const nodeAgents = node.agents ?? [];

  const knownRoles = ['*', ...nodeAgents.map((sa) => sa.name)];

  function updateChannels(next: WorkflowChannel[]) {
    onUpdate({ ...node, channels: next.length > 0 ? next : undefined });
  }

  function removeChannel(index: number) {
    updateChannels(channels.filter((_, i) => i !== index));
  }

  function addChannel(from: string, to: string, label?: string) {
    if (!from || !to) return;
    const toValue: string | string[] = to.includes(',')
      ? to
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : to;
    updateChannels([
      ...channels,
      { id: crypto.randomUUID(), from, to: toValue, label: label || undefined },
    ]);
  }

  return (
    <div class="space-y-2 pt-2 border-t border-dark-700">
      <label class="text-xs font-medium text-gray-400">
        Channels <span class="text-gray-400 font-normal">(messaging topology)</span>
      </label>

      {channels.length === 0 && (
        <p class="text-xs text-gray-400">No channels — agents are isolated.</p>
      )}

      <div class="space-y-1">
        {channels.map((ch, i) => (
          <div
            key={i}
            class="flex items-center gap-2 bg-dark-800 border border-dark-600 rounded px-2 py-1.5"
          >
            <span class="text-xs text-gray-300 font-mono flex-1">
              {ch.from} → {formatTo(ch.to)}
              {ch.label && <span class="text-gray-400 ml-1">"{ch.label}"</span>}
            </span>
            <button
              type="button"
              onClick={() => removeChannel(i)}
              class="text-gray-400 hover:text-red-400 transition-colors flex-shrink-0"
              title="Remove channel"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <AddChannelForm knownRoles={knownRoles} onAdd={addChannel} />
    </div>
  );
}

interface AddChannelFormProps {
  knownRoles: string[];
  onAdd: (from: string, to: string, label?: string) => void;
}

function AddChannelForm({ knownRoles, onAdd }: AddChannelFormProps) {
  return (
    <details class="group">
      <summary class="text-xs text-blue-400 hover:text-blue-300 cursor-pointer list-none">
        + Add channel
      </summary>
      <ChannelFormBody knownRoles={knownRoles} onAdd={onAdd} />
    </details>
  );
}

interface ChannelFormBodyProps {
  knownRoles: string[];
  onAdd: (from: string, to: string, label?: string) => void;
}

function ChannelFormBody({ knownRoles, onAdd }: ChannelFormBodyProps) {
  function handleSubmit(e: Event) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const from = (form.elements.namedItem('from') as HTMLSelectElement).value;
    const to = (form.elements.namedItem('to') as HTMLInputElement).value.trim();
    const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim();
    onAdd(from, to, label || undefined);
    form.reset();
  }

  return (
    <form
      onSubmit={handleSubmit}
      class="mt-2 space-y-2 bg-dark-800 border border-dark-600 rounded p-2"
    >
      <div class="flex gap-2">
        <select
          name="from"
          class="flex-1 text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500"
        >
          <option value="">From…</option>
          {knownRoles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <input
        name="to"
        type="text"
        placeholder="To role(s) — comma-separated for fan-out, * for all"
        class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
      />
      <input
        name="label"
        type="text"
        placeholder="Label (optional)"
        class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500 placeholder-gray-600"
      />
      <button
        type="submit"
        class="w-full text-xs py-1 rounded bg-dark-700 hover:bg-dark-600 text-gray-300 transition-colors"
      >
        Add
      </button>
    </form>
  );
}

interface WorkflowNodeCardProps {
  node: NodeDraft;
  nodeIndex: number;
  isFirst: boolean;
  isLast: boolean;
  expanded: boolean;
  agents: SpaceWorkerAgent[];
  onToggleExpand: () => void;
  onUpdate: (node: NodeDraft) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  disableRemove?: boolean;
  nodeTaskStates?: AgentTaskState[];
}

export function WorkflowNodeCard({
  node,
  nodeIndex,
  isFirst,
  isLast,
  expanded,
  agents,
  onToggleExpand,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onRemove,
  disableRemove = false,
  nodeTaskStates,
}: WorkflowNodeCardProps) {
  const multi = isMultiAgentNode(node);
  const agentName = agents.find((a) => a.id === node.agentId)?.name ?? node.agentId;

  const taskStateByAgent = new Map<string | null, AgentTaskState>(
    (nodeTaskStates ?? []).map((s) => [s.agentName, s])
  );
  const allDone = isNodeFullyCompleted(nodeTaskStates ?? []);

  return (
    <div
      class={cn(
        'border rounded-lg overflow-hidden',
        allDone ? 'border-green-700/60' : 'border-dark-700'
      )}
    >
      <div
        class={cn(
          'flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none',
          expanded ? 'bg-dark-800 border-b border-dark-700' : 'bg-dark-850 hover:bg-dark-800'
        )}
        onClick={onToggleExpand}
      >
        <span
          class={cn(
            'w-5 h-5 flex items-center justify-center rounded-full text-xs font-semibold flex-shrink-0',
            allDone ? 'bg-green-800 text-green-300' : 'bg-dark-700 text-gray-400'
          )}
          data-testid="node-step-badge"
        >
          {nodeIndex + 1}
        </span>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span class="text-xs font-medium text-gray-200 truncate">
              {node.name || 'Unnamed Node'}
            </span>
            <span class="text-xs text-gray-400 flex-shrink-0">·</span>
            {multi ? (
              <span class="flex items-center gap-1 flex-wrap">
                {node.agents!.map((a) => {
                  const name = agents.find((ag) => ag.id === a.agentId)?.name ?? a.agentId ?? '';
                  const hasOverrides = !!a.customPrompt;
                  const taskState = taskStateByAgent.get(a.name);
                  return (
                    <span
                      key={a.name}
                      class={cn(
                        'text-xs border rounded px-1 py-0.5 flex items-center gap-0.5',
                        hasOverrides
                          ? 'bg-amber-950/30 border-amber-700/50 text-amber-300'
                          : 'bg-dark-700 border-dark-600 text-gray-300'
                      )}
                      title={`${name} — slot: ${a.name}${hasOverrides ? ' (has overrides)' : ''}`}
                    >
                      <span>{a.name}</span>
                      {hasOverrides && !taskState && (
                        <span
                          data-testid="override-dot"
                          class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                        />
                      )}
                      {taskState && <AgentStatusIcon state={taskState} />}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span class="flex items-center gap-1 text-xs text-gray-400 truncate flex-shrink-0">
                <span>{agentName || '—'}</span>
                {taskStateByAgent.get(null) && (
                  <AgentStatusIcon state={taskStateByAgent.get(null)!} />
                )}
              </span>
            )}
          </div>
          {nodeTaskStates && nodeTaskStates.some((s) => s.completionSummary) && (
            <p class="text-xs text-gray-400 truncate mt-0.5" data-testid="node-completion-summary">
              {nodeTaskStates.find((s) => s.completionSummary)?.completionSummary}
            </p>
          )}
        </div>

        <div class="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            class="p-1 rounded text-gray-400 hover:text-gray-300 hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Move up"
          >
            <ChevronUp />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            class="p-1 rounded text-gray-400 hover:text-gray-300 hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Move down"
          >
            <ChevronDown />
          </button>
          <button
            onClick={onRemove}
            disabled={disableRemove}
            class="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-dark-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Remove node"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <span class="text-gray-400 flex-shrink-0">
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </span>
      </div>

      {expanded && (
        <div class="px-4 py-4 bg-dark-900 space-y-4">
          <div class="space-y-1">
            <label class="text-xs font-medium text-gray-400">Node Name</label>
            <input
              type="text"
              value={node.name}
              onInput={(e) =>
                onUpdate({ ...node, name: (e.currentTarget as HTMLInputElement).value })
              }
              placeholder="e.g. Plan the approach"
              class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
            />
          </div>

          {multi ? (
            <MultiAgentSection node={node} agents={agents} onUpdate={onUpdate} />
          ) : (
            <div class="space-y-1">
              <div class="flex items-center justify-between">
                <label class="text-xs font-medium text-gray-400">Agent</label>
                <button
                  type="button"
                  onClick={() => {
                    const firstId = node.agentId;
                    const firstAgentRole = firstId
                      ? (agents.find((a) => a.id === firstId)?.name ?? firstId)
                      : '';
                    const existing: WorkflowNodeAgent[] = firstId
                      ? [{ agentId: firstId, name: firstAgentRole }]
                      : [];
                    onUpdate({ ...node, agents: existing, agentId: '' });
                  }}
                  class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  + Add agent
                </button>
              </div>
              <select
                value={node.agentId}
                onChange={(e) =>
                  onUpdate({ ...node, agentId: (e.currentTarget as HTMLSelectElement).value })
                }
                class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">— Select agent —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div class="space-y-1">
            <label class="text-xs font-medium text-gray-400">
              Custom Prompt <span class="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              value={extractOverrideValue(node.customPrompt)}
              onInput={(e) => {
                const value = (e.currentTarget as HTMLTextAreaElement).value;
                onUpdate({
                  ...node,
                  customPrompt: buildOverride(value),
                });
              }}
              placeholder="Node-specific prompt appended to the agent's custom prompt…"
              data-testid="single-agent-system-prompt"
              rows={4}
              class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700 resize-y"
            />
          </div>
        </div>
      )}
    </div>
  );
}
