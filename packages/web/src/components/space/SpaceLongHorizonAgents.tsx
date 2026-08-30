import type {
  SpaceWorkerAgent,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentTemplate,
  ThinkingLevel,
} from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { navigateToSpaceSession } from '../../lib/router';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';

const THINKING_LEVEL_OPTIONS: Array<{ value: '' | ThinkingLevel; label: string }> = [
  { value: '', label: 'Use app default' },
  { value: 'off', label: 'Off' },
  { value: 'think8k', label: 'Think 8k' },
  { value: 'think16k', label: 'Think 16k' },
  { value: 'think24k', label: 'Think 24k' },
  { value: 'think32k', label: 'Think 32k' },
];

const AUTONOMY_LABELS: Record<number, string> = {
  1: 'Supervised',
  2: 'Semi-auto',
  3: 'Autonomous',
  4: 'Full auto',
  5: 'Unrestricted',
};

function isCoordinator(agent: SpaceLongHorizonAgent): boolean {
  return agent.handle === 'coordinator';
}

function agentInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

type SelectedAgentDetail =
  | { source: 'long-horizon'; agent: SpaceLongHorizonAgent }
  | { source: 'space-agent'; agent: SpaceWorkerAgent };

function selectedAgentName(detail: SelectedAgentDetail): string {
  return detail.source === 'long-horizon' ? detail.agent.displayName : detail.agent.name;
}

function selectedAgentStatus(detail: SelectedAgentDetail): string {
  return detail.agent.status ?? 'active';
}

function selectedAgentInstructions(detail: SelectedAgentDetail): string | null {
  return detail.source === 'long-horizon' ? detail.agent.instructions : detail.agent.customPrompt;
}

function selectedAgentAutonomyLevel(detail: SelectedAgentDetail): number | null {
  return detail.source === 'long-horizon' ? detail.agent.autonomyLevel : null;
}

function selectedAgentModel(detail: SelectedAgentDetail): string | null | undefined {
  return detail.agent.model;
}

function selectedAgentThinkingLevel(detail: SelectedAgentDetail): ThinkingLevel | null | undefined {
  return detail.agent.thinkingLevel;
}

function nextFreeHandle(base: string, existingHandles: Set<string>): string {
  if (!existingHandles.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existingHandles.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

interface AgentEditorProps {
  template?: SpaceLongHorizonAgentTemplate | null;
  agent?: SpaceLongHorizonAgent | null;
  existingHandles: Set<string>;
  onSave: () => void;
  onCancel: () => void;
}

function AgentEditor({ template, agent, existingHandles, onSave, onCancel }: AgentEditorProps) {
  const isEdit = !!agent;
  const [displayName, setDisplayName] = useState(agent?.displayName ?? template?.displayName ?? '');
  const [handle, setHandle] = useState(
    agent?.handle ?? (template ? nextFreeHandle(template.handle, existingHandles) : '')
  );
  const [instructions, setInstructions] = useState(
    agent?.instructions ?? template?.instructions ?? ''
  );
  const [autonomyLevel, setAutonomyLevel] = useState<number | null>(
    agent?.autonomyLevel ?? template?.suggestedAutonomyLevel ?? null
  );
  const [model, setModel] = useState(agent?.model ?? '');
  const [modelProvider, setModelProvider] = useState<string | undefined>(undefined);
  const [thinkingLevel, setThinkingLevel] = useState<'' | ThinkingLevel>(
    agent?.thinkingLevel ?? ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!displayName.trim()) {
      setError('Name is required');
      return;
    }
    if (!handle.trim()) {
      setError('Handle is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit && agent) {
        await spaceStore.updateLongHorizonAgent(agent.id, {
          displayName: displayName.trim(),
          instructions: instructions.trim(),
          autonomyLevel: autonomyLevel as 1 | 2 | 3 | 4 | 5 | null,
          model: model.trim() || null,
          thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
        });
      } else {
        await spaceStore.createLongHorizonAgent({
          handle: handle.trim(),
          displayName: displayName.trim(),
          templateKey: template?.key ?? null,
          instructions: instructions.trim(),
          autonomyLevel: autonomyLevel as 1 | 2 | 3 | 4 | 5 | null,
          model: model.trim() || null,
          thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
        });
      }
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-scrim p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <div class="relative isolate max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-hidden rounded-t-3xl border border-line bg-surface/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_28px_90px_rgba(0,0,0,0.55)] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(circle_at_4%_0%,rgba(145,77,108,0.22),transparent_34%),radial-gradient(circle_at_100%_6%,rgba(42,94,125,0.18),transparent_38%)] sm:rounded-3xl">
        <div class="flex items-start justify-between border-b border-line px-5 py-5 sm:px-7">
          <div>
            <p class="text-xl font-semibold tracking-tight text-fg">
              {isEdit
                ? `Edit ${agent?.displayName}`
                : `New agent${template ? ` · ${template.displayName}` : ''}`}
            </p>
            <p class="mt-1 text-sm text-fg-muted">
              Define the role, autonomy, and model for this space.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close agent editor"
            class="rounded-xl border border-transparent p-2 text-fg-muted transition-colors hover:border-line hover:bg-fill-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
          >
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="max-h-[calc(100dvh-11rem)] space-y-5 overflow-y-auto px-5 py-5 scrollbar-dark sm:px-7 sm:py-6">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Name</label>
              <input
                type="text"
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                class="w-full rounded-xl border border-line bg-surface-overlay/90 px-4 py-3 text-sm text-fg placeholder-gray-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10"
                placeholder="e.g. Release Manager"
              />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Handle</label>
              <input
                type="text"
                value={handle}
                disabled={isEdit}
                onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
                class="w-full rounded-xl border border-line bg-surface-overlay/90 px-4 py-3 text-sm text-fg placeholder-gray-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10 disabled:opacity-50"
                placeholder="e.g. release-manager"
              />
            </div>
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Instructions</label>
            <textarea
              value={instructions}
              onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
              rows={5}
              class="w-full resize-none rounded-2xl border border-line bg-surface-overlay/90 px-4 py-3 text-sm leading-relaxed text-fg placeholder-gray-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10"
              placeholder="What should this agent do?"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Autonomy level</label>
            <div class="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setAutonomyLevel(autonomyLevel === level ? null : level)}
                  class={`flex-1 rounded-xl border py-2.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 ${
                    autonomyLevel === level
                      ? 'border-warning/40 bg-warning text-on-warning shadow-[0_8px_20px_rgba(251,191,36,0.14)]'
                      : 'border-line bg-surface-overlay/85 text-fg-muted hover:border-line hover:bg-surface-raised hover:text-fg-soft'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
            {autonomyLevel && (
              <p class="mt-1 text-xs text-fg-muted">{AUTONOMY_LABELS[autonomyLevel]}</p>
            )}
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Model</label>
              <WorkflowModelSelect
                value={model || undefined}
                provider={modelProvider}
                onChange={(modelId, selection) => {
                  setModel(modelId ?? '');
                  setModelProvider(selection?.provider);
                }}
                testId="lh-agent-model-select"
                className="w-full rounded-xl border border-line bg-surface-overlay/90 px-3 py-2.5 text-sm text-fg focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10"
              />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Thinking</label>
              <select
                value={thinkingLevel}
                onChange={(e) =>
                  setThinkingLevel((e.target as HTMLSelectElement).value as '' | ThinkingLevel)
                }
                class="w-full rounded-xl border border-line bg-surface-overlay/90 px-3 py-2.5 text-sm text-fg focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10"
              >
                {THINKING_LEVEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && <p class="text-xs text-danger">{error}</p>}
        </div>
        <div class="flex justify-end gap-3 border-t border-line bg-scrim-soft px-5 py-4 sm:px-7">
          <Button variant="ghost" size="md" onClick={onCancel} class="rounded-xl px-5">
            Cancel
          </Button>
          <Button
            size="md"
            onClick={handleSave}
            disabled={saving}
            class="rounded-xl bg-warning px-6 font-semibold text-on-warning shadow-[0_10px_28px_rgba(251,191,36,0.16)] hover:bg-amber-200"
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TemplateEditor({ onCancel }: { onCancel: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [key, setKey] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [autonomyLevel, setAutonomyLevel] = useState(2);

  const fieldClass =
    'w-full rounded-xl border border-line bg-surface-overlay/90 px-4 py-3 text-sm text-fg placeholder-gray-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors focus:border-warning/45 focus:outline-none focus:ring-2 focus:ring-warning/10';

  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-scrim p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <div class="relative isolate max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-hidden rounded-t-3xl border border-line bg-surface/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_28px_90px_rgba(0,0,0,0.55)] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[radial-gradient(circle_at_4%_0%,rgba(145,77,108,0.22),transparent_34%),radial-gradient(circle_at_100%_6%,rgba(42,94,125,0.18),transparent_38%)] sm:rounded-3xl">
        <div class="flex items-start justify-between border-b border-line px-5 py-5 sm:px-7">
          <div>
            <p class="text-xl font-semibold tracking-tight text-fg">New template</p>
            <p class="mt-1 text-sm text-fg-muted">
              Create a reusable role preset for agents in this space.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close template editor"
            class="rounded-xl border border-transparent p-2 text-fg-muted transition-colors hover:border-line hover:bg-fill-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
          >
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div class="max-h-[calc(100dvh-11rem)] space-y-5 overflow-y-auto px-5 py-5 scrollbar-dark sm:px-7 sm:py-6">
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Name</label>
              <input
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                class={fieldClass}
                placeholder="e.g. Release Readiness"
              />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-fg-soft">Template key</label>
              <input
                value={key}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
                class={fieldClass}
                placeholder="e.g. release-readiness.custom"
              />
            </div>
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Default agent handle</label>
            <input
              value={handle}
              onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
              class={fieldClass}
              placeholder="e.g. release-readiness"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Description</label>
            <input
              value={description}
              onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
              class={fieldClass}
              placeholder="A concise summary shown on the template card"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Instructions</label>
            <textarea
              value={instructions}
              onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
              rows={5}
              class={`${fieldClass} resize-none leading-relaxed`}
              placeholder="What should agents created from this template do?"
            />
          </div>
          <div>
            <label class="mb-2 block text-sm font-medium text-fg-soft">Suggested autonomy</label>
            <div class="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setAutonomyLevel(level)}
                  class={`flex-1 rounded-xl border py-2.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 ${autonomyLevel === level ? 'border-warning/40 bg-warning text-on-warning' : 'border-line bg-surface-overlay/85 text-fg-muted hover:border-line hover:text-fg-soft'}`}
                >
                  {level}
                </button>
              ))}
            </div>
            <p class="mt-1.5 text-xs text-fg-muted">{AUTONOMY_LABELS[autonomyLevel]}</p>
          </div>
          <div class="rounded-xl border border-warning-soft/20 bg-warning/[0.07] px-4 py-3 text-sm text-warning-soft/80">
            Custom template persistence is coming soon. These fields are available for preview, but
            cannot be saved yet.
          </div>
        </div>
        <div class="flex justify-end gap-3 border-t border-line bg-scrim-soft px-5 py-4 sm:px-7">
          <Button variant="ghost" size="md" onClick={onCancel} class="rounded-xl px-5">
            Close
          </Button>
          <Button
            size="md"
            disabled
            title="Custom template persistence is not available yet"
            class="rounded-xl bg-warning px-6 font-semibold text-on-warning"
          >
            Create template
          </Button>
        </div>
      </div>
    </div>
  );
}

interface AgentCardProps {
  agent: SpaceLongHorizonAgent;
  spaceId: string;
  navigationSpaceId: string;
  reminderCount: number;
  onEdit: () => void;
  onDelete: () => void;
}

function AgentCard({
  agent,
  spaceId,
  navigationSpaceId,
  reminderCount,
  onEdit,
  onDelete,
}: AgentCardProps) {
  const coordinator = isCoordinator(agent);
  const statusColors: Record<string, string> = {
    active: 'bg-success',
    paused: 'bg-warning',
    disabled: 'bg-fg-faint',
    archived: 'bg-fill-strong',
  };

  const sessionId = agent.sessionId ?? (coordinator ? `space:chat:${spaceId}` : null);

  return (
    <div
      role={sessionId ? 'button' : undefined}
      tabIndex={sessionId ? 0 : undefined}
      onClick={sessionId ? () => navigateToSpaceSession(navigationSpaceId, sessionId) : undefined}
      onKeyDown={
        sessionId
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ')
                navigateToSpaceSession(navigationSpaceId, sessionId);
            }
          : undefined
      }
      class={`group flex min-h-32 flex-col rounded-xl border border-line bg-surface-overlay/90 px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-raised/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${sessionId ? 'cursor-pointer' : ''}`}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <span class="grid h-10 w-10 flex-none place-items-center rounded-xl border border-line bg-fill-soft text-xs font-semibold italic text-accent-soft">
            {agentInitials(agent.displayName)}
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-base font-semibold tracking-tight text-fg">
                {agent.displayName}
              </span>
              {coordinator && (
                <span class="flex-shrink-0 rounded-full border border-purple-400/20 bg-cat-purple/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cat-purple">
                  Coordinator
                </span>
              )}
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
              <span
                class={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusColors[agent.status] ?? 'bg-fg-faint'}`}
              />
              <span>{agent.status}</span>
              {agent.autonomyLevel && (
                <>
                  <span>·</span>
                  <span>
                    L{agent.autonomyLevel} {AUTONOMY_LABELS[agent.autonomyLevel]}
                  </span>
                </>
              )}
              {reminderCount > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {reminderCount} reminder{reminderCount !== 1 ? 's' : ''}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div class="flex flex-shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            class="rounded-md p-1.5 text-fg-faint transition-colors hover:bg-fill-soft hover:text-fg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            title="Edit"
            aria-label={`Edit ${agent.displayName}`}
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          {!coordinator && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              class="rounded-md p-1.5 text-fg-faint transition-colors hover:bg-fill-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
              title="Delete"
              aria-label={`Delete ${agent.displayName}`}
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
      {agent.instructions && (
        <p class="mt-4 line-clamp-2 text-sm leading-relaxed text-fg-soft">{agent.instructions}</p>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  addedCount,
  onClick,
}: {
  template: SpaceLongHorizonAgentTemplate;
  addedCount: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="group min-h-28 rounded-xl border border-line bg-surface-overlay/85 px-4 py-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all hover:-translate-y-0.5 hover:border-blue-400/30 hover:bg-surface-raised/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-sm font-semibold tracking-tight text-fg">{template.displayName}</span>
        {addedCount > 0 ? (
          <span class="flex-shrink-0 rounded bg-fill-soft px-1.5 py-0.5 text-xs text-fg-muted">
            ×{addedCount}
          </span>
        ) : (
          <svg
            class="w-3.5 h-3.5 flex-shrink-0 text-fg-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        )}
      </div>
      <p class="mt-1.5 line-clamp-2 text-sm leading-relaxed text-fg-soft">{template.description}</p>
    </button>
  );
}

export function SpaceLongHorizonAgents({
  spaceId,
  navigationSpaceId,
  selectedHandle,
}: {
  spaceId: string;
  navigationSpaceId?: string;
  selectedHandle?: string | null;
}) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const agents = spaceStore.longHorizonAgents.value;
  const spaceAgents = spaceStore.agents.value;
  const templates = spaceStore.longHorizonAgentTemplates.value;
  const loading = !spaceStore.configDataLoaded.value;

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  const [reminderCounts, setReminderCounts] = useState<Record<string, number>>({});
  const [selectedTemplate, setSelectedTemplate] = useState<SpaceLongHorizonAgentTemplate | null>(
    null
  );
  const [editingAgent, setEditingAgent] = useState<SpaceLongHorizonAgent | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState<SpaceLongHorizonAgent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;
    spaceStore
      .listLongHorizonAgentReminderCounts(agents.map((agent) => agent.id))
      .then((counts) => {
        if (!cancelled) setReminderCounts(counts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agents.length, spaceId]);

  const handleEditorSave = () => {
    setShowEditor(false);
    setSelectedTemplate(null);
    setEditingAgent(null);
  };

  const handleEditorCancel = () => {
    setShowEditor(false);
    setSelectedTemplate(null);
    setEditingAgent(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingAgent) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await spaceStore.deleteLongHorizonAgent(deletingAgent.id);
      toast.success(`"${deletingAgent.displayName}" deleted`);
      setDeletingAgent(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      setDeleting(false);
    }
  };

  const coordinator = agents.find(isCoordinator);
  const others = agents.filter((a) => !isCoordinator(a) && a.status !== 'archived');
  const sortedAgents = coordinator ? [coordinator, ...others] : others;
  const selectedLongHorizonAgent = selectedHandle
    ? sortedAgents.find((agent) => agent.handle === selectedHandle)
    : null;
  const selectedSpaceAgent = selectedHandle
    ? spaceAgents.find((agent) => agent.handle === selectedHandle && agent.status !== 'archived')
    : null;
  const selectedAgent: SelectedAgentDetail | null = selectedSpaceAgent
    ? { source: 'space-agent', agent: selectedSpaceAgent }
    : selectedLongHorizonAgent
      ? { source: 'long-horizon', agent: selectedLongHorizonAgent }
      : null;
  const existingHandles = new Set(agents.map((a) => a.handle));

  const templateInstanceCounts = new Map<string, number>();
  for (const agent of agents.filter((agent) => agent.status !== 'archived')) {
    if (!agent.templateKey) continue;
    templateInstanceCounts.set(
      agent.templateKey,
      (templateInstanceCounts.get(agent.templateKey) ?? 0) + 1
    );
  }

  if (loading) {
    return (
      <div class="flex-1 flex items-center justify-center">
        <span class="text-xs text-fg-muted animate-pulse">Loading agents…</span>
      </div>
    );
  }

  return (
    <div class="h-full overflow-y-auto scrollbar-dark">
      <div class="mx-auto max-w-6xl space-y-7 px-4 py-4 sm:px-8 sm:py-6">
        <section
          class={`flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6 glass-surface`}
          data-testid="space-agents-introduction"
          aria-label="Agents workspace summary"
        >
          <div class="max-w-2xl">
            <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-warning-soft/80">
              <span class="h-1.5 w-1.5 rounded-full bg-warning" />
              Long-horizon agents
            </div>
            <h2 class="mt-2 text-lg font-semibold tracking-tight text-fg">
              Configured agents ·{' '}
              <span data-testid="configured-agent-count">{sortedAgents.length}</span>
            </h2>
            <p class="mt-1 text-sm leading-5 text-fg-soft">
              Persistent Space actors — coordinators, workers, and custom roles — rehydrated by the
              runtime and recalled across runs.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setSelectedTemplate(null);
              setEditingAgent(null);
              setShowEditor(true);
            }}
            class="glass-primary-button"
          >
            + Custom agent
          </button>
        </section>

        {selectedHandle && (
          <section
            class={`rounded-2xl border border-blue-400/25 border-l-blue-300/60 p-5 flat-surface`}
            data-testid="space-agent-detail"
          >
            {selectedAgent ? (
              <>
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-xs font-semibold uppercase tracking-wider text-accent-soft/70">
                      Selected agent
                    </p>
                    <h2 class="mt-1 text-base font-semibold text-fg">
                      {selectedAgentName(selectedAgent)}
                    </h2>
                    <p class="mt-0.5 text-xs text-fg-muted">@{selectedAgent.agent.handle}</p>
                  </div>
                  <span class="flex-shrink-0 rounded-full bg-fill px-2 py-0.5 text-xs text-fg-soft">
                    {selectedAgentStatus(selectedAgent)}
                  </span>
                </div>
                {selectedAgentInstructions(selectedAgent) && (
                  <p class="mt-3 text-sm text-fg-soft whitespace-pre-wrap">
                    {selectedAgentInstructions(selectedAgent)}
                  </p>
                )}
                <div class="mt-3 flex flex-wrap gap-2 text-xs text-fg-muted">
                  {selectedAgent.source === 'space-agent' && <span>Configured Worker Agent</span>}
                  {selectedAgentAutonomyLevel(selectedAgent) && (
                    <span>
                      L{selectedAgentAutonomyLevel(selectedAgent)}{' '}
                      {AUTONOMY_LABELS[selectedAgentAutonomyLevel(selectedAgent)!]}
                    </span>
                  )}
                  {selectedAgentModel(selectedAgent) && (
                    <span>Model: {selectedAgentModel(selectedAgent)}</span>
                  )}
                  {selectedAgentThinkingLevel(selectedAgent) && (
                    <span>Thinking: {selectedAgentThinkingLevel(selectedAgent)}</span>
                  )}
                </div>
              </>
            ) : (
              <div data-testid="space-agent-detail-missing">
                <p class="text-sm font-medium text-fg">Agent not found</p>
                <p class="mt-1 text-xs text-fg-muted">No agent found for @{selectedHandle}.</p>
              </div>
            )}
          </section>
        )}

        <section aria-label="Configured agents">
          {sortedAgents.length === 0 ? (
            <div class={`rounded-2xl border px-5 py-8 text-center flat-surface`}>
              <p class="text-sm font-medium text-fg-soft">No configured agents yet</p>
              <p class="mt-1 text-xs text-fg-muted">
                Add a custom agent or choose a template below.
              </p>
            </div>
          ) : (
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {sortedAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  spaceId={spaceId}
                  navigationSpaceId={routeSpaceId}
                  reminderCount={reminderCounts[agent.id] ?? 0}
                  onEdit={() => {
                    setEditingAgent(agent);
                    setSelectedTemplate(null);
                    setShowEditor(true);
                  }}
                  onDelete={() => {
                    setDeletingAgent(agent);
                    setDeleteError(null);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <div class="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 class="text-lg font-semibold tracking-tight text-fg">
                Templates · <span data-testid="agent-template-count">{templates.length}</span>
              </h3>
              <p class="mt-0.5 text-xs text-fg-faint">
                Add a focused role with preconfigured instructions.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowTemplateEditor(true)}
              class="text-xs font-medium text-accent-soft/85 underline-offset-4 transition-colors hover:text-accent-soft hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              New Template
            </button>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <TemplateCard
                key={t.key}
                template={t}
                addedCount={templateInstanceCounts.get(t.key) ?? 0}
                onClick={() => {
                  setSelectedTemplate(t);
                  setEditingAgent(null);
                  setShowEditor(true);
                }}
              />
            ))}
          </div>
        </section>
      </div>

      {showEditor && (
        <AgentEditor
          template={selectedTemplate}
          agent={editingAgent}
          existingHandles={existingHandles}
          onSave={handleEditorSave}
          onCancel={handleEditorCancel}
        />
      )}

      {showTemplateEditor && <TemplateEditor onCancel={() => setShowTemplateEditor(false)} />}

      {deletingAgent && (
        <ConfirmModal
          isOpen
          onClose={() => {
            setDeletingAgent(null);
            setDeleteError(null);
          }}
          onConfirm={handleDeleteConfirm}
          title="Delete Agent"
          message={`Delete "${deletingAgent.displayName}"? This cannot be undone.`}
          confirmText="Delete"
          confirmButtonVariant="danger"
          isLoading={deleting}
          error={deleteError}
        />
      )}
    </div>
  );
}
