import type {
  SpaceWorkerAgent,
  ThinkingLevel,
  WorkflowChannel,
  WorkflowHook,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import { generateUUID, normalizeThinkingLevel } from '@hyperneo/shared';
import { useComputed } from '@preact/signals';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { skillsStore } from '../../../lib/skills-store';
import type { NodeDraft } from '../WorkflowNodeCard';
import { buildOverride, extractOverrideValue, isMultiAgentNode } from '../WorkflowNodeCard';
import { ChannelRelationConfigPanel } from './ChannelRelationConfigPanel';
import { HookEditorPanel } from './HookEditorPanel';
import { WorkflowModelSelect } from './WorkflowModelSelect';

function isCoordinatorAgent(agent: SpaceWorkerAgent): boolean {
  return agent.name.toLowerCase() === 'coordinator' || agent.templateName === 'Coordinator';
}

const THINKING_LEVEL_OPTIONS: Array<{ value: '' | ThinkingLevel; label: string }> = [
  { value: '', label: 'Inherit' },
  { value: 'off', label: 'Off' },
  { value: 'think8k', label: 'Think 8k' },
  { value: 'think16k', label: 'Think 16k' },
  { value: 'think24k', label: 'Think 24k' },
  { value: 'think32k', label: 'Think 32k' },
];

function safeNodeThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
  if (!level) return undefined;
  return normalizeThinkingLevel(level);
}

function normalizeNodeDraftThinkingLevel(draft: NodeDraft): NodeDraft {
  let changed = false;

  let stepThinkingLevel: string | undefined = draft.thinkingLevel;
  if (stepThinkingLevel === 'auto') {
    stepThinkingLevel = 'off';
    changed = true;
  }

  let normalizedAgents: WorkflowNodeAgent[] | undefined = draft.agents;
  if (draft.agents) {
    normalizedAgents = draft.agents.map((agent) => {
      const agentThinking: string | undefined = agent.thinkingLevel;
      if (agentThinking === 'auto') {
        changed = true;
        return { ...agent, thinkingLevel: 'off' };
      }
      return agent;
    });
  }

  if (!changed) return draft;

  return {
    ...draft,
    thinkingLevel: stepThinkingLevel as ThinkingLevel,
    agents: normalizedAgents,
  };
}

export interface NodeChannelLink {
  id: string;
  label: string;
  channelCount: number;
}

export interface NodeConfigPanelProps {
  step: NodeDraft;
  agents: SpaceWorkerAgent[];
  isStartNode: boolean;
  isEndNode: boolean;
  onUpdate: (step: NodeDraft) => void;
  onSetAsStart: (stepId: string) => void;
  onSetAsEnd: (stepId: string) => void;
  channelLinks?: NodeChannelLink[];
  onOpenChannelLink?: (channelLinkId: string) => void;
  selectedChannelRelation?: {
    title: string;
    description: string;
    forwardLinks: Array<{ index: number; channel: WorkflowChannel }>;
    reverseLinks?: Array<{ index: number; channel: WorkflowChannel }>;
    canConvertToBidirectional?: boolean;
  };
  onUpdateChannelLink?: (index: number, channel: WorkflowChannel) => void;
  onDeleteChannelLink?: (index: number) => void;
  onConvertChannelRelationToBidirectional?: () => void;
  onCloseChannelLink?: () => void;
  onClose: () => void;
  onDelete: (stepId: string) => void;
  nodeHooks?: WorkflowHook[];
  workflowNodeNames?: string[];
  onUpdateNodeHooks?: (hooks: WorkflowHook[]) => void;
}

interface SlotSkillsToggleProps {
  disabledSkillIds?: string[];
  onChange: (disabledSkillIds: string[]) => void;
}

function SlotSkillsToggle({ disabledSkillIds, onChange }: SlotSkillsToggleProps) {
  const allSkills = useComputed(() => skillsStore.skills.value.filter((s) => s.enabled));
  if (allSkills.value.length === 0) return null;

  const disabledSet = new Set(disabledSkillIds ?? []);

  return (
    <div class="space-y-1">
      <label class="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
        Skills
      </label>
      <div class="space-y-0.5">
        {allSkills.value.map((skill) => {
          const isEnabled = !disabledSet.has(skill.id);
          return (
            <label key={skill.id} class="flex items-center gap-1.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={() => {
                  const next = new Set(disabledSet);
                  if (isEnabled) {
                    next.add(skill.id);
                  } else {
                    next.delete(skill.id);
                  }
                  onChange(next.size > 0 ? Array.from(next) : []);
                }}
                class="w-3 h-3 rounded accent-blue-500 flex-shrink-0"
              />
              <span class="text-[11px] text-fg-muted group-hover:text-fg-soft transition-colors truncate">
                {skill.displayName}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

interface SlotResetContextToggleProps {
  checked: boolean;
  onChange: (enabled: boolean) => void;
}

function SlotResetContextToggle({ checked, onChange }: SlotResetContextToggleProps) {
  return (
    <label class="flex items-start gap-1.5 cursor-pointer group">
      <input
        type="checkbox"
        data-testid="agent-slot-reset-context-toggle"
        checked={checked}
        onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
        class="w-3 h-3 rounded accent-blue-500 flex-shrink-0 mt-0.5"
      />
      <div class="flex flex-col">
        <span class="text-[11px] font-medium text-fg-soft group-hover:text-fg transition-colors">
          Fresh context each turn
        </span>
        <span class="text-[10px] text-fg-muted leading-tight">
          Clears the agent's model memory on each handoff so every turn starts fresh (fresh eyes).
          UI history is preserved — only the model's context is wiped.
        </span>
      </div>
    </label>
  );
}

interface AgentsSectionProps {
  step: NodeDraft;
  agents: SpaceWorkerAgent[];
  onUpdate: (step: NodeDraft) => void;
  onEditSlotPrompts?: (role: string) => void;
  onEditSinglePrompts?: () => void;
}

function AgentsSection({
  step,
  agents,
  onUpdate,
  onEditSlotPrompts,
  onEditSinglePrompts,
}: AgentsSectionProps) {
  const multi = isMultiAgentNode(step);
  const nodeAgents = step.agents ?? [];
  const singleSlot = nodeAgents.length === 1 ? nodeAgents[0] : undefined;
  const selectedSingleAgentId = singleSlot?.agentId ?? step.agentId;
  const selectedSingleModel = singleSlot?.model ?? step.model;
  const selectedSingleThinkingLevel = safeNodeThinkingLevel(
    singleSlot?.thinkingLevel ?? step.thinkingLevel
  );
  const selectedSingleCustomPrompt = singleSlot?.customPrompt ?? step.customPrompt;
  const selectedSingleReplaceAgentPrompt =
    singleSlot?.replaceAgentPrompt ?? step.replaceAgentPrompt;

  function updateAgents(next: WorkflowNodeAgent[]) {
    onUpdate({ ...step, agents: next, agentId: '' });
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
    const next = [...nodeAgents, { agentId, name: role }];
    onUpdate({ ...step, agents: next, agentId: '' });
  }

  function removeAgent(role: string) {
    const removed = nodeAgents.find((a) => a.name === role);
    const next = nodeAgents.filter((a) => a.name !== role);
    if (next.length <= 1) {
      const survivor = next[0] ?? removed;
      onUpdate({
        ...step,
        agents: undefined,
        agentId: survivor?.agentId ?? '',
        model: survivor?.model,
        thinkingLevel: survivor?.thinkingLevel,
        customPrompt: survivor?.customPrompt,
        replaceAgentPrompt: survivor?.replaceAgentPrompt,
        disabledSkillIds: survivor?.disabledSkillIds,
        resetContextPerTurn: survivor?.resetContextPerTurn,
        channels: undefined,
      });
    } else {
      updateAgents(next);
    }
  }

  function updateAgentId(role: string, agentId: string) {
    updateAgents(nodeAgents.map((a) => (a.name === role ? { ...a, agentId } : a)));
  }

  function updateAgentModel(role: string, model: string | undefined) {
    updateAgents(
      nodeAgents.map((a) => (a.name === role ? { ...a, model: model || undefined } : a))
    );
  }

  function updateAgentThinkingLevel(role: string, thinkingLevel: '' | ThinkingLevel) {
    updateAgents(
      nodeAgents.map((a) =>
        a.name === role ? { ...a, thinkingLevel: thinkingLevel || undefined } : a
      )
    );
  }

  const updateSingleAgentId = useCallback(
    (newAgentId: string) => {
      if (singleSlot) {
        updateAgentId(singleSlot.name, newAgentId);
        return;
      }
      onUpdate({ ...step, agentId: newAgentId });
    },
    [singleSlot, step, onUpdate]
  );

  const updateSingleModel = useCallback(
    (model: string | undefined) => {
      if (singleSlot) {
        updateAgentModel(singleSlot.name, model);
        return;
      }
      onUpdate({ ...step, model });
    },
    [singleSlot, step, onUpdate]
  );

  const updateSingleThinkingLevel = useCallback(
    (thinkingLevel: '' | ThinkingLevel) => {
      if (singleSlot) {
        updateAgentThinkingLevel(singleSlot.name, thinkingLevel);
        return;
      }
      onUpdate({ ...step, thinkingLevel: thinkingLevel || undefined });
    },
    [singleSlot, step, onUpdate]
  );

  const availableAgents = agents;

  const thinkingSelectOptions = THINKING_LEVEL_OPTIONS.map((option) => (
    <option key={option.value || 'inherit'} value={option.value}>
      {option.label}
    </option>
  ));

  if (!multi) {
    return (
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label class="text-xs font-medium text-fg-muted">Agent</label>
          <button
            type="button"
            data-testid="add-agent-button"
            onClick={() => {
              const usedRoles = new Set<string>();
              const buildUniqueRole = (base: string): string => {
                const sanitizedBase = base.trim() || 'agent';
                let role = sanitizedBase;
                for (let i = 2; usedRoles.has(role); i++) {
                  role = `${sanitizedBase}-${i}`;
                }
                usedRoles.add(role);
                return role;
              };

              const primaryAgentId = selectedSingleAgentId || '';
              const primaryBaseRole =
                singleSlot?.name ||
                agents.find((a) => a.id === primaryAgentId)?.name ||
                primaryAgentId ||
                'agent';
              const primarySlot: WorkflowNodeAgent = {
                agentId: primaryAgentId,
                name: buildUniqueRole(primaryBaseRole),
                model: selectedSingleModel,
                thinkingLevel: selectedSingleThinkingLevel,
                customPrompt: selectedSingleCustomPrompt,
                replaceAgentPrompt: selectedSingleReplaceAgentPrompt,
                disabledSkillIds: singleSlot?.disabledSkillIds ?? step.disabledSkillIds,
                resetContextPerTurn: singleSlot?.resetContextPerTurn ?? step.resetContextPerTurn,
              };

              const secondaryAgent =
                agents.find((a) => a.id !== primaryAgentId && !isCoordinatorAgent(a)) ??
                agents.find((a) => a.id !== primaryAgentId) ??
                agents[0];
              const secondarySlot: WorkflowNodeAgent = {
                agentId: secondaryAgent?.id ?? '',
                name: buildUniqueRole(secondaryAgent?.name ?? 'agent'),
              };

              onUpdate({
                ...step,
                agents: [primarySlot, secondarySlot],
                agentId: '',
                model: undefined,
                thinkingLevel: undefined,
                customPrompt: undefined,
                replaceAgentPrompt: undefined,
                channels: undefined,
              });
            }}
            class="text-xs text-accent hover:text-accent-soft transition-colors"
          >
            + Add agent
          </button>
        </div>
        <select
          data-testid="agent-select"
          value={selectedSingleAgentId}
          onChange={(e) => updateSingleAgentId((e.currentTarget as HTMLSelectElement).value)}
          class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1.5 text-fg-soft focus:outline-none focus:border-accent"
        >
          <option value="">— Select agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div class="space-y-1">
          <label class="text-xs font-medium text-fg-muted">
            LLM Model <span class="font-normal text-fg-muted">(optional override)</span>
          </label>
          <WorkflowModelSelect
            testId="single-agent-model-input"
            value={selectedSingleModel}
            onChange={updateSingleModel}
          />
        </div>
        <div class="space-y-1">
          <label class="text-xs font-medium text-fg-muted">
            Thinking Level <span class="font-normal text-fg-muted">(optional override)</span>
          </label>
          <select
            value={selectedSingleThinkingLevel ?? ''}
            onChange={(e) =>
              updateSingleThinkingLevel(
                (e.currentTarget as HTMLSelectElement).value as '' | ThinkingLevel
              )
            }
            class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1.5 text-fg-soft focus:outline-none focus:border-accent"
          >
            {thinkingSelectOptions}
          </select>
        </div>
        <SlotSkillsToggle
          disabledSkillIds={singleSlot?.disabledSkillIds}
          onChange={(disabledSkillIds) => {
            if (singleSlot) {
              updateAgents(
                nodeAgents.map((a) =>
                  a.name === singleSlot.name
                    ? {
                        ...a,
                        disabledSkillIds:
                          disabledSkillIds.length > 0 ? disabledSkillIds : undefined,
                      }
                    : a
                )
              );
            } else {
              onUpdate({
                ...step,
                agents: [
                  {
                    agentId: selectedSingleAgentId || '',
                    name: step.name || 'agent',
                    model: selectedSingleModel,
                    thinkingLevel: selectedSingleThinkingLevel,
                    customPrompt: selectedSingleCustomPrompt,
                    replaceAgentPrompt: selectedSingleReplaceAgentPrompt,
                    disabledSkillIds: disabledSkillIds.length > 0 ? disabledSkillIds : undefined,
                    resetContextPerTurn: step.resetContextPerTurn,
                  },
                ],
                agentId: '',
                model: undefined,
                thinkingLevel: undefined,
                customPrompt: undefined,
                replaceAgentPrompt: undefined,
              });
            }
          }}
        />
        <SlotResetContextToggle
          checked={!!(singleSlot?.resetContextPerTurn ?? step.resetContextPerTurn)}
          onChange={(enabled) => {
            if (singleSlot) {
              updateAgents(
                nodeAgents.map((a) =>
                  a.name === singleSlot.name
                    ? { ...a, resetContextPerTurn: enabled || undefined }
                    : a
                )
              );
            } else {
              onUpdate({ ...step, resetContextPerTurn: enabled || undefined });
            }
          }}
        />
        <button
          type="button"
          data-testid="edit-single-prompts-button"
          onClick={() => onEditSinglePrompts?.()}
          class="w-full text-xs border border-line rounded px-2 py-1.5 text-fg-soft hover:border-line-strong hover:bg-fill-strong/40 transition-colors"
        >
          Edit Prompts
        </button>
      </div>
    );
  }

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <label class="text-xs font-medium text-fg-muted">
          Agents <span class="text-fg-muted">({nodeAgents.length})</span>
        </label>
      </div>

      <div class="space-y-1.5" data-testid="agents-list">
        {nodeAgents.map((sa) => {
          const agentInfo = agents.find((a) => a.id === sa.agentId);
          return (
            <div
              key={sa.name}
              class="rounded p-2 space-y-1 border bg-surface-raised border-line-strong"
              data-testid="agent-entry"
            >
              <div class="flex items-center gap-1">
                <input
                  type="text"
                  data-testid="agent-role-input"
                  value={sa.name}
                  onInput={(e) => {
                    const newRole = (e.currentTarget as HTMLInputElement).value;
                    updateAgents(
                      nodeAgents.map((a) => (a.name === sa.name ? { ...a, name: newRole } : a))
                    );
                  }}
                  placeholder="node role"
                  class="flex-1 text-xs font-mono bg-surface border border-line rounded px-1.5 py-0.5 text-fg-soft focus:outline-none focus:border-accent placeholder-gray-600 min-w-0"
                />
                <button
                  type="button"
                  data-testid="remove-agent-button"
                  onClick={() => removeAgent(sa.name)}
                  class="text-fg-muted hover:text-danger transition-colors flex-shrink-0"
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
              <div class="space-y-1">
                <label class="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
                  Agent
                </label>
                <select
                  data-testid="agent-slot-select"
                  value={sa.agentId}
                  onChange={(e) =>
                    updateAgentId(sa.name, (e.currentTarget as HTMLSelectElement).value)
                  }
                  class="w-full text-xs bg-surface border border-line rounded px-2 py-1 text-fg-soft focus:outline-none focus:border-accent"
                >
                  <option value="">— Select agent —</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <p class="text-[11px] text-fg-muted">{agentInfo?.name ?? sa.agentId}</p>
              </div>
              <div class="space-y-1">
                <label class="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
                  Model
                </label>
                <WorkflowModelSelect
                  testId="agent-slot-model-input"
                  value={sa.model}
                  onChange={(model) => updateAgentModel(sa.name, model)}
                />
              </div>
              <div class="space-y-1">
                <label class="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-muted">
                  Thinking
                </label>
                <select
                  value={safeNodeThinkingLevel(sa.thinkingLevel) ?? ''}
                  onChange={(e) =>
                    updateAgentThinkingLevel(
                      sa.name,
                      (e.currentTarget as HTMLSelectElement).value as '' | ThinkingLevel
                    )
                  }
                  class="w-full text-xs bg-surface border border-line rounded px-2 py-1 text-fg-soft focus:outline-none focus:border-accent"
                >
                  {thinkingSelectOptions}
                </select>
              </div>
              <button
                type="button"
                data-testid="edit-slot-prompts-button"
                onClick={() => onEditSlotPrompts?.(sa.name)}
                class="w-full text-xs border border-line rounded px-2 py-1.5 text-fg-soft hover:border-line-strong hover:bg-fill-strong/40 transition-colors"
              >
                Edit Prompts
              </button>
              <SlotSkillsToggle
                disabledSkillIds={sa.disabledSkillIds}
                onChange={(disabledSkillIds) => {
                  updateAgents(
                    nodeAgents.map((a) =>
                      a.name === sa.name
                        ? {
                            ...a,
                            disabledSkillIds:
                              disabledSkillIds.length > 0 ? disabledSkillIds : undefined,
                          }
                        : a
                    )
                  );
                }}
              />
              <SlotResetContextToggle
                checked={!!sa.resetContextPerTurn}
                onChange={(enabled) => {
                  updateAgents(
                    nodeAgents.map((a) =>
                      a.name === sa.name ? { ...a, resetContextPerTurn: enabled || undefined } : a
                    )
                  );
                }}
              />
            </div>
          );
        })}
      </div>

      {availableAgents.length > 0 && (
        <select
          data-testid="add-agent-select"
          value=""
          onChange={(e) => {
            addAgent((e.currentTarget as HTMLSelectElement).value);
            (e.currentTarget as HTMLSelectElement).value = '';
          }}
          class="w-full text-xs bg-surface-raised border border-line-strong border-dashed rounded px-2 py-1.5 text-fg-muted focus:outline-none focus:border-accent"
        >
          <option value="">+ Add agent…</option>
          {availableAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

interface CustomPromptEditorProps {
  customPrompt?: NodeDraft['customPrompt'];
  onChange: (value: string) => void;
  testId: string;
  placeholder: string;
  rows?: number;
}

function PromptModeToggle({
  replace,
  onChange,
}: {
  replace: boolean;
  onChange: (replace: boolean) => void;
}) {
  return (
    <div class="space-y-1">
      <label class="text-xs font-medium text-fg-muted">Prompt Mode</label>
      <div
        class="grid grid-cols-2 gap-1 rounded border border-line bg-surface-raised p-0.5"
        data-testid="prompt-mode-toggle"
      >
        <button
          type="button"
          data-testid="prompt-mode-append"
          onClick={() => onChange(false)}
          class={`text-[11px] rounded px-2 py-1 transition-colors ${
            !replace ? 'bg-accent-hover text-accent-fg' : 'text-fg-muted hover:text-fg-soft'
          }`}
        >
          Append to agent prompt
        </button>
        <button
          type="button"
          data-testid="prompt-mode-replace"
          onClick={() => onChange(true)}
          class={`text-[11px] rounded px-2 py-1 transition-colors ${
            replace ? 'bg-warning text-accent-fg' : 'text-fg-muted hover:text-fg-soft'
          }`}
        >
          Replace agent prompt
        </button>
      </div>
      <p class="text-[11px] text-fg-faint">
        {!replace
          ? "Added after the agent's base prompt (e.g. the Reviewer contract)."
          : "The agent's base prompt will NOT be used for this slot — only the SDK base contract + the text below applies."}
      </p>
      {replace && (
        <p data-testid="replace-prompt-warning" class="text-[11px] text-warning">
          Warning: the agent's base prompt is replaced by the text below. If the text below is
          empty, this slot runs on the SDK base contract alone.
        </p>
      )}
    </div>
  );
}

function CustomPromptEditor({
  customPrompt,
  onChange,
  testId,
  placeholder,
  rows = 6,
}: CustomPromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const value = extractOverrideValue(customPrompt);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div class="space-y-1">
      <label class="text-xs font-medium text-fg-muted">Custom Prompt</label>
      <textarea
        ref={textareaRef}
        data-testid={testId}
        value={value}
        onInput={(e) => onChange((e.currentTarget as HTMLTextAreaElement).value)}
        rows={rows}
        placeholder={placeholder}
        style={{ minHeight: `${rows * 1.5}rem` }}
        class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1.5 text-fg-soft focus:outline-none focus:border-accent placeholder-gray-700 resize-none overflow-y-auto max-h-96"
      />
    </div>
  );
}

type PanelView =
  | { kind: 'main' }
  | { kind: 'channel-links' }
  | { kind: 'hook-editor'; hookId: string }
  | { kind: 'single-prompts' }
  | { kind: 'slot-prompts'; role: string };

export function NodeConfigPanel({
  step,
  agents,
  isStartNode,
  isEndNode,
  onUpdate,
  onSetAsStart,
  onSetAsEnd,
  channelLinks = [],
  onOpenChannelLink,
  selectedChannelRelation,
  onUpdateChannelLink,
  onDeleteChannelLink,
  onConvertChannelRelationToBidirectional,
  onCloseChannelLink,
  onClose,
  onDelete,
  nodeHooks = [],
  workflowNodeNames = [],
  onUpdateNodeHooks,
}: NodeConfigPanelProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>({ kind: 'main' });

  useEffect(() => {
    setConfirmingDelete(false);
    setPanelView({ kind: 'main' });
  }, [step.localId]);

  useEffect(() => {
    const normalized = normalizeNodeDraftThinkingLevel(step);
    if (normalized !== step) {
      onUpdate(normalized);
    }
  }, [step, onUpdate]);

  useEffect(() => {
    if (selectedChannelRelation) {
      setPanelView({ kind: 'channel-links' });
      return;
    }
    setPanelView((prev) => (prev.kind === 'channel-links' ? { kind: 'main' } : prev));
  }, [selectedChannelRelation]);

  const handleDeleteClick = () => {
    if (isStartNode) return;
    setConfirmingDelete(true);
  };

  const handleDeleteConfirm = () => {
    setConfirmingDelete(false);
    onDelete(step.localId);
  };

  const handleDeleteCancel = () => {
    setConfirmingDelete(false);
  };

  const handleTogglePostApproval = (enabled: boolean) => {
    if (!enabled) {
      const next = { ...step };
      delete next.postApproval;
      onUpdate(next);
      return;
    }

    onUpdate({
      ...step,
      postApproval: {
        targetAgent: step.postApproval?.targetAgent ?? '',
        instructions: step.postApproval?.instructions ?? '',
        ...(step.requirePrMerge ? { requirePrMerge: true } : {}),
      },
    });
  };

  const handleUpdatePostApproval = (patch: Partial<NonNullable<NodeDraft['postApproval']>>) => {
    if (!step.postApproval) return;
    onUpdate({
      ...step,
      postApproval: {
        ...step.postApproval,
        ...patch,
      },
    });
  };

  const renderHeader = () => {
    if (panelView.kind === 'main') {
      return (
        <div class="flex items-center justify-between border-b border-line bg-surface-overlay/60 px-4 py-3 flex-shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            {isStartNode && (
              <span
                data-testid="start-node-badge"
                class="text-xs font-bold text-success uppercase tracking-wider flex-shrink-0"
              >
                START
              </span>
            )}
            {isEndNode && (
              <span
                data-testid="end-node-badge"
                class="text-xs font-bold text-cat-purple uppercase tracking-wider flex-shrink-0"
              >
                END
              </span>
            )}
            <h3 class="text-sm font-semibold text-fg truncate">{step.name || 'Unnamed Node'}</h3>
          </div>
          <button
            data-testid="close-button"
            onClick={onClose}
            class="p-1 rounded text-fg-muted hover:text-fg-soft hover:bg-fill-strong transition-colors flex-shrink-0"
            title="Close panel"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      );
    }

    const title =
      panelView.kind === 'channel-links'
        ? 'Channel Links'
        : panelView.kind === 'hook-editor'
          ? 'Hook Editor'
          : panelView.kind === 'single-prompts'
            ? 'Prompts'
            : panelView.kind === 'slot-prompts'
              ? 'Slot Prompts'
              : step.name || 'Unnamed Node';

    return (
      <div class="flex items-center justify-between border-b border-line bg-surface-overlay/60 px-4 py-3 flex-shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <button
            type="button"
            data-testid="node-panel-back-button"
            onClick={() => {
              if (panelView.kind === 'hook-editor') {
                setPanelView({ kind: 'main' });
                return;
              }
              if (panelView.kind === 'slot-prompts') {
                setPanelView({ kind: 'main' });
                return;
              }
              if (panelView.kind === 'single-prompts') {
                setPanelView({ kind: 'main' });
                return;
              }
              if (panelView.kind === 'channel-links') {
                onCloseChannelLink?.();
              }
              setPanelView({ kind: 'main' });
            }}
            class="p-1 rounded text-fg-muted hover:text-fg-soft hover:bg-fill-strong transition-colors flex-shrink-0"
            title="Back"
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
          <h3 class="text-sm font-semibold text-fg truncate">{title}</h3>
        </div>
        <button
          data-testid="close-button"
          onClick={onClose}
          class="p-1 rounded text-fg-muted hover:text-fg-soft hover:bg-fill-strong transition-colors flex-shrink-0"
          title="Close panel"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    );
  };

  const renderPanelBody = () => {
    if (panelView.kind === 'hook-editor') {
      const editingHook = nodeHooks.find((h) => h.id === panelView.hookId);
      if (!editingHook) return null;
      return (
        <HookEditorPanel
          hook={editingHook}
          nodeNames={workflowNodeNames}
          onChange={(updated) => {
            onUpdateNodeHooks?.(nodeHooks.map((h) => (h.id === updated.id ? updated : h)));
          }}
          onBack={() => setPanelView({ kind: 'main' })}
          embedded
        />
      );
    }

    if (panelView.kind === 'single-prompts') {
      const nodeAgents = step.agents ?? [];
      const singleSlot = nodeAgents.length === 1 ? nodeAgents[0] : undefined;
      const singleAgentId = singleSlot?.agentId ?? step.agentId;
      const singleAgent = agents.find((agent) => agent.id === singleAgentId);
      const singleCustomPrompt = singleSlot?.customPrompt ?? step.customPrompt;
      const singleReplaceAgentPrompt = singleSlot?.replaceAgentPrompt ?? step.replaceAgentPrompt;

      const updateSingleCustomPrompt = (value: string) => {
        if (singleSlot) {
          onUpdate({
            ...step,
            agents: nodeAgents.map((agent) =>
              agent.name === singleSlot.name
                ? { ...agent, customPrompt: buildOverride(value) }
                : agent
            ),
            agentId: '',
          });
          return;
        }

        onUpdate({
          ...step,
          customPrompt: buildOverride(value),
        });
      };

      const updateSingleReplaceAgentPrompt = (replace: boolean) => {
        if (singleSlot) {
          onUpdate({
            ...step,
            agents: nodeAgents.map((agent) =>
              agent.name === singleSlot.name
                ? { ...agent, replaceAgentPrompt: replace || undefined }
                : agent
            ),
            agentId: '',
          });
          return;
        }

        onUpdate({
          ...step,
          replaceAgentPrompt: replace || undefined,
        });
      };

      return (
        <div class="scrollbar-dark flex-1 overflow-y-auto px-4 py-4 pr-5 space-y-4">
          <div class="rounded border border-line bg-surface-overlay px-3 py-2 text-xs text-fg-muted space-y-1">
            <p>
              <span class="text-fg-muted">Agent:</span>{' '}
              {(singleAgent?.name ?? singleAgentId) || '—'}
            </p>
          </div>
          <PromptModeToggle
            replace={singleReplaceAgentPrompt === true}
            onChange={updateSingleReplaceAgentPrompt}
          />
          <CustomPromptEditor
            customPrompt={singleCustomPrompt}
            onChange={updateSingleCustomPrompt}
            testId="single-prompts-system-prompt"
            placeholder="Custom prompt appended to the agent's base prompt…"
            rows={8}
          />
        </div>
      );
    }

    if (panelView.kind === 'slot-prompts') {
      const slot = (step.agents ?? []).find((agent) => agent.name === panelView.role);
      if (!slot) return null;
      const slotAgent = agents.find((agent) => agent.id === slot.agentId);

      const updateSlot = (nextSlot: WorkflowNodeAgent) => {
        onUpdate({
          ...step,
          agents: (step.agents ?? []).map((agent) =>
            agent.name === panelView.role ? nextSlot : agent
          ),
          agentId: '',
        });
      };

      return (
        <div class="scrollbar-dark flex-1 overflow-y-auto px-4 py-4 pr-5 space-y-4">
          <div class="rounded border border-line bg-surface-overlay px-3 py-2 text-xs text-fg-muted space-y-1">
            <p>
              <span class="text-fg-muted">Role:</span> {slot.name}
            </p>
            <p>
              <span class="text-fg-muted">Agent:</span> {slotAgent?.name ?? slot.agentId}
            </p>
          </div>
          <div class="space-y-1">
            <label class="text-xs font-medium text-fg-muted">
              LLM Model <span class="font-normal text-fg-muted">(optional override)</span>
            </label>
            <WorkflowModelSelect
              testId="slot-prompts-model-input"
              value={slot.model}
              onChange={(model) => updateSlot({ ...slot, model: model || undefined })}
            />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-medium text-fg-muted">
              Thinking Level <span class="font-normal text-fg-muted">(optional override)</span>
            </label>
            <select
              value={safeNodeThinkingLevel(slot.thinkingLevel) ?? ''}
              onChange={(e) =>
                updateSlot({
                  ...slot,
                  thinkingLevel:
                    ((e.currentTarget as HTMLSelectElement).value as '' | ThinkingLevel) ||
                    undefined,
                })
              }
              class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1.5 text-fg-soft focus:outline-none focus:border-accent"
            >
              {THINKING_LEVEL_OPTIONS.map((option) => (
                <option key={option.value || 'inherit'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <PromptModeToggle
            replace={slot.replaceAgentPrompt === true}
            onChange={(replace) =>
              updateSlot({ ...slot, replaceAgentPrompt: replace || undefined })
            }
          />
          <CustomPromptEditor
            customPrompt={slot.customPrompt}
            onChange={(value) => updateSlot({ ...slot, customPrompt: buildOverride(value) })}
            testId="slot-prompts-system-prompt"
            placeholder="Custom prompt appended to the agent's base prompt (optional)…"
            rows={8}
          />
        </div>
      );
    }

    if (panelView.kind === 'channel-links' && selectedChannelRelation) {
      return (
        <ChannelRelationConfigPanel
          title={selectedChannelRelation.title}
          description={selectedChannelRelation.description}
          forwardLinks={selectedChannelRelation.forwardLinks}
          reverseLinks={selectedChannelRelation.reverseLinks}
          canConvertToBidirectional={selectedChannelRelation.canConvertToBidirectional}
          onConvertToBidirectional={onConvertChannelRelationToBidirectional}
          onChange={(index, channel) => onUpdateChannelLink?.(index, channel)}
          onDelete={(index) => onDeleteChannelLink?.(index)}
          onClose={onClose}
          embedded
        />
      );
    }

    return (
      <div class="scrollbar-dark flex-1 overflow-y-auto px-4 py-4 pr-5 space-y-5">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-fg-muted">Node Name</label>
          <input
            data-testid="step-name-input"
            type="text"
            value={step.name}
            onInput={(e) =>
              onUpdate({ ...step, name: (e.currentTarget as HTMLInputElement).value })
            }
            placeholder="e.g. Plan the approach"
            class="w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1.5 text-fg-soft focus:outline-none focus:border-accent placeholder-gray-700"
          />
        </div>

        {!isStartNode && (
          <button
            data-testid="set-as-start-button"
            onClick={() => onSetAsStart(step.localId)}
            class="w-full text-xs font-medium py-1.5 px-3 rounded border border-success text-success hover:bg-success/30 transition-colors"
          >
            Set as Start Node
          </button>
        )}
        {!isEndNode && (
          <button
            data-testid="set-as-end-button"
            onClick={() => onSetAsEnd(step.localId)}
            class="w-full text-xs font-medium py-1.5 px-3 rounded border border-cat-purple text-cat-purple hover:bg-cat-purple/30 transition-colors"
          >
            Set as End Node
          </button>
        )}
        {isEndNode && (
          <button
            data-testid="unset-as-end-button"
            onClick={() => onSetAsEnd(step.localId)}
            class="w-full text-xs font-medium py-1.5 px-3 rounded border border-cat-purple/50 text-cat-purple/60 hover:bg-cat-purple/20 transition-colors"
          >
            Unset End Node
          </button>
        )}

        <AgentsSection
          step={step}
          agents={agents}
          onUpdate={onUpdate}
          onEditSinglePrompts={() => setPanelView({ kind: 'single-prompts' })}
          onEditSlotPrompts={(role) => setPanelView({ kind: 'slot-prompts', role })}
        />

        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-fg-muted">Channel Links</label>
            <span class="text-xs text-fg-muted">{channelLinks.length}</span>
          </div>
          {channelLinks.length > 0 ? (
            <div class="space-y-1.5">
              {channelLinks.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  data-testid="node-channel-link-button"
                  onClick={() => {
                    setPanelView({ kind: 'channel-links' });
                    onOpenChannelLink?.(link.id);
                  }}
                  class="w-full rounded border border-line bg-surface-raised px-2.5 py-2 text-left hover:border-teal-600/60 hover:bg-line transition-colors"
                >
                  <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0">
                      <div class="text-xs font-mono text-fg-soft truncate">{link.label}</div>
                      <div class="mt-1 flex items-center gap-2 text-[11px] text-fg-muted">
                        <span>
                          {link.channelCount} link{link.channelCount === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                    <svg
                      class="w-4 h-4 text-fg-muted flex-shrink-0"
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
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p class="text-xs text-fg-muted">Create links by dragging from one node to another.</p>
          )}
        </div>

        <div class="rounded-lg border border-line bg-surface-overlay p-3">
          <label class="flex items-center gap-2 text-xs text-fg-soft">
            <input
              type="checkbox"
              checked={!!step.postApproval}
              data-testid="post-approval-enabled-checkbox"
              onChange={(e) =>
                handleTogglePostApproval((e.currentTarget as HTMLInputElement).checked)
              }
              class="w-3 h-3 rounded accent-blue-500"
            />
            <span class="font-medium">Post-approval instruction</span>
          </label>
          <p class="mt-2 text-xs leading-5 text-fg-muted">
            Run this node again with follow-up instructions after it approves or submits the task
            for approval.
          </p>
          {step.postApproval ? (
            <textarea
              value={step.postApproval.instructions}
              data-testid="post-approval-instructions-textarea"
              onInput={(e) =>
                handleUpdatePostApproval({
                  instructions: (e.currentTarget as HTMLTextAreaElement).value,
                })
              }
              placeholder="Instructions for the follow-up run…"
              rows={4}
              class="mt-3 min-h-24 w-full resize-y rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-soft placeholder-gray-600 focus:border-accent focus:outline-none"
            />
          ) : null}
        </div>

        {onUpdateNodeHooks && (
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="text-xs font-medium text-fg-muted">Hooks</label>
              <span class="text-xs text-fg-muted">{nodeHooks.length}</span>
            </div>
            {nodeHooks.length > 0 ? (
              <div class="space-y-1.5">
                {nodeHooks.map((hook) => (
                  <button
                    key={hook.id}
                    type="button"
                    data-testid="node-hook-button"
                    onClick={() => setPanelView({ kind: 'hook-editor', hookId: hook.id })}
                    class="w-full rounded border border-line bg-surface-raised px-2.5 py-2 text-left hover:border-accent-hover/60 hover:bg-line transition-colors"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="min-w-0">
                        <div class="text-xs font-mono text-fg-soft truncate">
                          {hook.label || hook.id}
                        </div>
                        <div class="mt-1 flex items-center gap-2 text-[11px] text-fg-muted">
                          <span>{hook.method}</span>
                          {!hook.enabled && <span class="text-danger">disabled</span>}
                        </div>
                      </div>
                      <svg
                        class="w-4 h-4 text-fg-muted flex-shrink-0"
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
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p class="text-xs text-fg-muted">No hooks configured for this node.</p>
            )}
            <button
              type="button"
              data-testid="add-hook-button"
              onClick={() => {
                const sourceNode = step.name || step.localId;
                const newHook: WorkflowHook = {
                  id: generateUUID(),
                  enabled: true,
                  sourceNode,
                  method: 'send_message',
                  validator: {
                    kind: 'script',
                    interpreter: 'bash',
                    source: `echo '{"type":"allow"}'`,
                  },
                  authorizedCallers: [{ sourceNode }],
                };
                onUpdateNodeHooks([...nodeHooks, newHook]);
                setPanelView({ kind: 'hook-editor', hookId: newHook.id });
              }}
              class="w-full rounded border border-dashed border-line-strong px-2 py-1.5 text-xs text-fg-muted hover:border-accent hover:text-accent-soft transition-colors"
            >
              + Add Hook
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      data-testid="node-config-panel"
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        bottom: 12,
        width: 340,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      }}
      class="animate-slideInRight overflow-hidden rounded-xl border border-line bg-surface/95 shadow-2xl shadow-black/40 backdrop-blur"
    >
      {renderHeader()}
      {renderPanelBody()}

      <div class="flex-shrink-0 border-t border-line bg-surface-overlay/60 px-4 py-3">
        {confirmingDelete ? (
          <div class="space-y-2">
            <p class="text-xs text-fg-muted">Delete this node? This cannot be undone.</p>
            <div class="flex gap-2">
              <button
                data-testid="delete-confirm-button"
                onClick={handleDeleteConfirm}
                class="flex-1 text-xs py-1.5 px-3 rounded bg-danger hover:bg-danger text-accent-fg font-medium transition-colors"
              >
                Delete
              </button>
              <button
                data-testid="delete-cancel-button"
                onClick={handleDeleteCancel}
                class="flex-1 text-xs py-1.5 px-3 rounded border border-line-strong text-fg-muted hover:text-fg-soft hover:bg-fill-strong transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            data-testid="delete-step-button"
            onClick={handleDeleteClick}
            disabled={isStartNode}
            title={isStartNode ? 'Designate another node as start before deleting' : 'Delete node'}
            class="w-full text-xs py-1.5 px-3 rounded border border-red-900 text-danger hover:bg-danger/30 hover:text-danger disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Delete Node
          </button>
        )}
        {isStartNode && !confirmingDelete && (
          <p class="text-xs text-fg-muted mt-1.5 text-center">
            Designate another node as start before deleting.
          </p>
        )}
      </div>
    </div>
  );
}
