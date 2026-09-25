import {
  type CloneChildrenChoice,
  type CloneSummary,
  type SettingSource,
  type WorktreeCommitStatus,
  type SpaceLongHorizonAgent,
  type SpaceLongHorizonAgentTemplate,
  type AgentModelPoolEntry,
} from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { navigateToSpaceAgent, navigateToSpaceSession } from '../../lib/router';
import { spaceStore } from '../../lib/space-store';
import { AUTONOMY_LABELS, toolPermissionsToolsList } from './agent-page-labels';
import { SpaceTemplatesPanel } from './SpaceTemplatesPanel';
import { extraToolsOf, withExtraTool, withoutExtraTool } from './template-extra-tools';
import { toast } from '../../lib/toast';
import { ConfirmModal } from '../ui/ConfirmModal';
import { CloneChoiceDialog } from '../CloneChoiceDialog';
import { FORM_CONTROL_CLASS, FormActions, FormField } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { LineNumberedTextarea } from './LineNumberedTextarea';
import {
  isStoredAsPool,
  modelConfigFromPool,
  poolFromModelConfig,
  storedModelConfig,
  thinkingLevelForSave,
} from './agent-model-pool';
import { ModelPoolEditor } from './ModelPoolEditor';
import { SettingSourcesEditor } from './SettingSourcesEditor';
import { ToolsEditor, type ToolsSelection } from './ToolsEditor';

function agentToolsList(agent: SpaceLongHorizonAgent): string[] {
  return toolPermissionsToolsList(agent);
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

function nextFreeHandle(base: string, existingHandles: Set<string>): string {
  if (!existingHandles.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existingHandles.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function nextFreeDisplayName(base: string, existingNames: Set<string>): string {
  const taken = new Set([...existingNames].map((name) => name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

interface AgentSaveForm {
  displayName: string;
  handle: string;
  instructions: string;
  autonomyLevel: number | null;
  modelPool: AgentModelPoolEntry[];
  tools: string[];
  pendingTool: string;
  settingSources: SettingSource[] | null;
}

interface AgentSaveCtx {
  agent: SpaceLongHorizonAgent | null;
  template: SpaceLongHorizonAgentTemplate | null;
  form: AgentSaveForm;
  displayName: string;
  handle: string;
  instructions: string;
  parsedTools: string[];
  toolsChanged: boolean;
}

function agentSaveValidateStage(ctx: AgentSaveCtx): AgentSaveCtx {
  if (!ctx.form.displayName.trim()) throw new Error('Name is required');
  if (!ctx.form.handle.trim()) throw new Error('Handle is required');
  return ctx;
}

function agentSaveNormalizeStage(ctx: AgentSaveCtx): AgentSaveCtx {
  return {
    ...ctx,
    displayName: ctx.form.displayName.trim(),
    handle: ctx.form.handle.trim(),
    instructions: ctx.form.instructions.trim(),
  };
}

function agentSaveParseToolsStage(ctx: AgentSaveCtx): AgentSaveCtx {
  const pendingTool = ctx.form.pendingTool.trim();
  const parsedTools =
    pendingTool && !ctx.form.tools.includes(pendingTool)
      ? [...ctx.form.tools, pendingTool]
      : ctx.form.tools;
  return {
    ...ctx,
    parsedTools,
    toolsChanged:
      parsedTools.join('\n') !== (ctx.agent ? agentToolsList(ctx.agent).join('\n') : ''),
  };
}

async function agentSavePersistStage(ctx: AgentSaveCtx): Promise<AgentSaveCtx> {
  const { form, parsedTools, toolsChanged, displayName, handle, instructions } = ctx;
  const storedSource = ctx.agent ?? ctx.template;
  const modelConfig = modelConfigFromPool(form.modelPool, isStoredAsPool(storedSource));
  const thinkingLevel = thinkingLevelForSave(modelConfig, storedSource);
  if (ctx.agent) {
    await spaceStore.updateAgent(ctx.agent.id, {
      displayName,
      instructions,
      autonomyLevel: form.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null,
      model: modelConfig.model,
      ...(modelConfig.provider !== storedModelConfig(ctx.agent).provider
        ? { provider: modelConfig.provider }
        : {}),
      thinkingLevel,
      settingSources: form.settingSources,
      ...(toolsChanged
        ? { toolPermissions: { ...ctx.agent.toolPermissions, tools: parsedTools } }
        : {}),
      modelPool: modelConfig.modelPool,
    });
    return ctx;
  }
  await spaceStore.createAgent({
    handle,
    displayName,
    templateKey: ctx.template?.key ?? null,
    instructions,
    autonomyLevel: form.autonomyLevel as 1 | 2 | 3 | 4 | 5 | null,
    model: modelConfig.model,
    ...(modelConfig.provider ? { provider: modelConfig.provider } : {}),
    thinkingLevel,
    settingSources: form.settingSources,
    ...(parsedTools.length > 0 ? { tools: parsedTools } : {}),
    ...(ctx.template?.suggestedEventSubscriptions.length
      ? { suggestedEventSubscriptions: ctx.template.suggestedEventSubscriptions }
      : {}),
    ...(ctx.template?.reminderDefaults.length
      ? { reminderDefaults: ctx.template.reminderDefaults }
      : {}),
    modelPool: modelConfig.modelPool ?? undefined,
  });
  return ctx;
}

const runAgentSave = (superpipe({})('save-unified-agent') as PipelineAPI)
  .input(['ctx'])
  .pipe(agentSaveValidateStage, 'ctx', 'ctx')
  .pipe(agentSaveNormalizeStage, 'ctx', 'ctx')
  .pipe(agentSaveParseToolsStage, 'ctx', 'ctx')
  .pipe(agentSavePersistStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: AgentSaveCtx) => Promise<AgentSaveCtx>;

interface AgentEditorProps {
  template?: SpaceLongHorizonAgentTemplate | null;
  agent?: SpaceLongHorizonAgent | null;
  existingHandles: Set<string>;
  existingNames: Set<string>;
  onSave: () => void;
  onCancel: () => void;
}

function AgentEditor({
  template,
  agent,
  existingHandles,
  existingNames,
  onSave,
  onCancel,
}: AgentEditorProps) {
  const isEdit = !!agent;
  const [displayName, setDisplayName] = useState(
    agent?.displayName ?? (template ? nextFreeDisplayName(template.displayName, existingNames) : '')
  );
  const [handle, setHandle] = useState(
    agent?.handle ?? (template ? nextFreeHandle(template.handle, existingHandles) : '')
  );
  const [instructions, setInstructions] = useState(
    agent?.instructions ?? template?.instructions ?? ''
  );
  const [autonomyLevel, setAutonomyLevel] = useState<number | null>(
    agent?.autonomyLevel ?? template?.suggestedAutonomyLevel ?? null
  );
  const [modelPool, setModelPool] = useState<AgentModelPoolEntry[]>(() =>
    poolFromModelConfig(agent ?? template)
  );
  const templateTools = template ? toolPermissionsToolsList(template) : [];
  const [toolsSelection, setToolsSelection] = useState<ToolsSelection>(
    agent
      ? { tools: agentToolsList(agent), toolsOverridden: agentToolsList(agent).length > 0 }
      : { tools: templateTools, toolsOverridden: templateTools.length > 0 }
  );
  const [settingSources, setSettingSources] = useState<SettingSource[] | null>(
    agent?.settingSources ?? template?.settingSources ?? null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraToolDraft, setExtraToolDraft] = useState('');
  const extraTools = extraToolsOf(toolsSelection.tools);

  const removeExtraTool = (tool: string) => {
    setToolsSelection((selection) => withoutExtraTool(selection, tool));
  };

  const addExtraTool = () => {
    const entry = extraToolDraft.trim();
    if (!entry) return;
    setToolsSelection((selection) => withExtraTool(selection, entry));
    setExtraToolDraft('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await runAgentSave({
        agent: isEdit ? agent : null,
        template: template ?? null,
        form: {
          displayName,
          handle,
          instructions,
          autonomyLevel,
          modelPool,
          tools: toolsSelection.tools,
          pendingTool: extraToolDraft,
          settingSources,
        },
        displayName: '',
        handle: '',
        instructions: '',
        parsedTools: [],
        toolsChanged: false,
      });
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={
        isEdit
          ? `Edit ${agent?.displayName}`
          : `New agent${template ? ` · ${template.displayName}` : ''}`
      }
      size="lg"
      footer={
        <FormActions
          error={error}
          onCancel={onCancel}
          submitLabel={isEdit ? 'Save changes' : 'Create agent'}
          submitting={saving}
          onSubmit={handleSave}
        />
      }
    >
      <div class="space-y-4">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Name">
            <input
              type="text"
              value={displayName}
              onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              class={FORM_CONTROL_CLASS}
              placeholder="e.g. Release Manager"
            />
          </FormField>
          <FormField label="Handle">
            <input
              type="text"
              value={handle}
              disabled={isEdit}
              onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
              class={FORM_CONTROL_CLASS}
              placeholder="e.g. release-manager"
            />
          </FormField>
        </div>
        <FormField label="Instructions">
          <LineNumberedTextarea
            value={instructions}
            onChange={setInstructions}
            rows={5}
            placeholder="What should this agent do?"
          />
        </FormField>
        <FormField label="Autonomy level">
          <div class="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setAutonomyLevel(autonomyLevel === level ? null : level)}
                class={`flex-1 rounded border py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                  autonomyLevel === level
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg-soft'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
          {autonomyLevel && (
            <p class="mt-1 text-xs text-fg-muted">{AUTONOMY_LABELS[autonomyLevel]}</p>
          )}
        </FormField>
        <FormField label="Model">
          <ModelPoolEditor modelPool={modelPool} onModelPoolChange={setModelPool} />
          {modelPool.length > 1 && (
            <p class="mt-2 text-xs text-fg-muted">
              This agent’s own session uses the first model. Pool weights apply to workflow tasks.
            </p>
          )}
        </FormField>
        <div>
          <ToolsEditor
            tools={toolsSelection.tools}
            toolsOverridden={toolsSelection.toolsOverridden}
            onChange={(next) => {
              setToolsSelection(next);
              setExtraToolDraft('');
            }}
          />
          <div data-testid="lh-agent-extra-tools" class="mt-3">
            {extraTools.length > 0 && (
              <>
                <p class="mb-1.5 text-xs text-fg-muted">
                  Scoped or custom tool entries on this profile:
                </p>
                <div class="mb-2 flex flex-wrap gap-1.5">
                  {extraTools.map((tool) => (
                    <span
                      key={tool}
                      class="flex items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 text-xs text-fg-soft"
                    >
                      <span class="font-mono">{tool}</span>
                      <button
                        type="button"
                        onClick={() => removeExtraTool(tool)}
                        aria-label={`Remove ${tool}`}
                        class="rounded p-0.5 text-fg-faint transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}
            <div class="flex items-center gap-2">
              <input
                type="text"
                value={extraToolDraft}
                onInput={(e) => setExtraToolDraft((e.target as HTMLInputElement).value)}
                class={`${FORM_CONTROL_CLASS} font-mono text-xs`}
                placeholder="Add scoped tool entry, e.g. Bash(gh pr view:*)"
                data-testid="lh-agent-extra-tool-input"
              />
              <button
                type="button"
                onClick={addExtraTool}
                class="flex-shrink-0 rounded border border-line px-2.5 py-1.5 text-xs text-fg-soft transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Add
              </button>
            </div>
          </div>
        </div>
        <FormField label="Setting sources">
          <SettingSourcesEditor value={settingSources} onChange={setSettingSources} />
          {settingSources === null ? (
            <p class="mt-1 text-xs text-fg-muted">Inherits the space setting sources.</p>
          ) : (
            <button
              type="button"
              onClick={() => setSettingSources(null)}
              class="mt-1 text-xs font-medium text-accent-soft/85 underline-offset-4 transition-colors hover:text-accent-soft hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              Clear override — inherit from space
            </button>
          )}
        </FormField>
      </div>
    </Modal>
  );
}

interface AgentCardProps {
  agent: SpaceLongHorizonAgent;
  navigationSpaceId: string;
  reminderCount: number;
  onEdit: () => void;
  onDelete: () => void;
}

function AgentCard({ agent, navigationSpaceId, reminderCount, onEdit, onDelete }: AgentCardProps) {
  const statusColors: Record<string, string> = {
    active: 'bg-success',
    paused: 'bg-warning',
    disabled: 'bg-fg-faint',
    archived: 'bg-fill-strong',
  };

  const sessionId = agent.sessionId ?? null;

  const openSession = () => navigateToSpaceAgent(navigationSpaceId, agent.handle);

  const [spawning, setSpawning] = useState(false);
  const spawnClone = () => {
    if (spawning) return;
    setSpawning(true);
    spaceStore
      .spawnAgentClone(agent.id)
      .then((cloneId) => navigateToSpaceSession(navigationSpaceId, cloneId))
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : 'Failed to start a new conversation')
      )
      .finally(() => setSpawning(false));
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openSession}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') openSession();
      }}
      class="group flex min-h-32 cursor-pointer flex-col rounded-xl px-4 py-3.5 flat-surface flat-hover transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
              <span
                class={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusColors[agent.status] ?? 'bg-fg-faint'}`}
              />
              <span>{agent.status}</span>
              <span>·</span>
              <span>{sessionId ? 'Session' : 'Start session'}</span>
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
          {agent.status === 'active' && (
            <button
              type="button"
              data-testid="agent-card-new-conversation"
              onClick={(e) => {
                e.stopPropagation();
                spawnClone();
              }}
              disabled={spawning}
              class="rounded-md p-1.5 text-fg-faint transition-colors hover:bg-fill-soft hover:text-fg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40"
              title="New conversation"
              aria-label={`New conversation with ${agent.displayName}`}
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </button>
          )}
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
        </div>
      </div>
      {agent.instructions && (
        <p class="mt-4 line-clamp-2 text-sm leading-relaxed text-fg-soft">{agent.instructions}</p>
      )}
    </div>
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
  const agents = spaceStore.agents.value;
  const templates = spaceStore.agentTemplates.value;
  const userTemplateKeys = spaceStore.userTemplateKeys.value;
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
  const [deletingAgent, setDeletingAgent] = useState<SpaceLongHorizonAgent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteClones, setDeleteClones] = useState<CloneSummary[] | null>(null);
  const [deleteCommits, setDeleteCommits] = useState<WorktreeCommitStatus | null>(null);
  const [deleteChildren, setDeleteChildren] = useState<CloneChildrenChoice | undefined>(undefined);

  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;
    spaceStore
      .listAgentReminderCounts(agents.map((agent) => agent.id))
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

  const handleDeleteConfirm = async (children?: CloneChildrenChoice, confirmed?: boolean) => {
    if (!deletingAgent) return;
    setDeleting(true);
    setDeleteError(null);
    setDeleteChildren(children);
    try {
      const refused = await spaceStore.deleteAgent(deletingAgent.id, children, confirmed);
      if (refused && 'clones' in refused) {
        setDeleteClones(refused.clones);
        return;
      }
      if (refused) {
        setDeleteCommits(refused.commitStatus);
        return;
      }
      toast.success(`"${deletingAgent.displayName}" deleted`);
      setDeletingAgent(null);
      setDeleteClones(null);
      setDeleteCommits(null);
      setDeleteChildren(undefined);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      setDeleting(false);
    }
  };

  const sortedAgents = agents.filter((a) => a.status !== 'archived');
  const selectedAgent = selectedHandle
    ? (agents.find((agent) => agent.handle === selectedHandle) ?? null)
    : null;
  const existingHandles = new Set(agents.map((a) => a.handle));
  const existingNames = new Set(agents.map((a) => a.displayName));

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
              Persistent Space actors — the Space Manager, workers, and custom roles — rehydrated by
              the runtime and recalled across runs.
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
                      {selectedAgent.displayName}
                    </h2>
                    <p class="mt-0.5 text-xs text-fg-muted">@{selectedAgent.handle}</p>
                  </div>
                  <div class="flex flex-shrink-0 flex-col items-end gap-2">
                    <span class="rounded-full bg-fill px-2 py-0.5 text-xs text-fg-soft">
                      {selectedAgent.status}
                    </span>
                  </div>
                </div>
                {selectedAgent.instructions && (
                  <p class="mt-3 text-sm text-fg-soft whitespace-pre-wrap">
                    {selectedAgent.instructions}
                  </p>
                )}
                <div class="mt-3 flex flex-wrap gap-2 text-xs text-fg-muted">
                  {selectedAgent.autonomyLevel && (
                    <span>
                      L{selectedAgent.autonomyLevel} {AUTONOMY_LABELS[selectedAgent.autonomyLevel]}
                    </span>
                  )}
                  {selectedAgent.model && <span>Model: {selectedAgent.model}</span>}
                  {selectedAgent.thinkingLevel && (
                    <span>Thinking: {selectedAgent.thinkingLevel}</span>
                  )}
                  {agentToolsList(selectedAgent).length > 0 && (
                    <span>{agentToolsList(selectedAgent).length} tools</span>
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

        <section aria-label="Agents">
          <div class="mb-3">
            <h3 class="text-lg font-semibold tracking-tight text-fg">
              Agents · <span data-testid="agent-instance-count">{sortedAgents.length}</span>
            </h3>
            <p class="mt-0.5 text-xs text-fg-faint">
              Template instances and custom agents running in this space.
            </p>
          </div>
          {sortedAgents.length === 0 ? (
            <div class={`rounded-2xl border px-5 py-8 text-center flat-surface`}>
              <p class="text-sm font-medium text-fg-soft">No agents yet</p>
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

        <SpaceTemplatesPanel
          spaceId={spaceId}
          templates={templates}
          userTemplateKeys={userTemplateKeys}
          onUseTemplate={(template) => {
            setSelectedTemplate(template);
            setEditingAgent(null);
            setShowEditor(true);
          }}
        />
      </div>

      {showEditor && (
        <AgentEditor
          template={selectedTemplate}
          agent={editingAgent}
          existingHandles={existingHandles}
          existingNames={existingNames}
          onSave={handleEditorSave}
          onCancel={handleEditorCancel}
        />
      )}

      {deletingAgent && deleteCommits && (
        <ConfirmModal
          isOpen
          onClose={() => {
            setDeleteCommits(null);
            setDeleteClones(null);
            setDeletingAgent(null);
          }}
          onConfirm={() => handleDeleteConfirm(deleteChildren, true)}
          title="Unpushed commits"
          message={`A conversation of "${deletingAgent.displayName}" has ${deleteCommits.commits.length} unpushed commit(s) on its worktree. Deleting will discard them.`}
          confirmText="Delete anyway"
          confirmButtonVariant="danger"
          isLoading={deleting}
          error={deleteError}
          confirmTestId="agent-delete-commits-confirm"
        />
      )}

      {deletingAgent && deleteClones && !deleteCommits && (
        <CloneChoiceDialog
          clones={deleteClones}
          action="delete"
          subject="agent"
          busy={deleting}
          onChoose={(choice) => handleDeleteConfirm(choice)}
          onCancel={() => {
            setDeleteClones(null);
            setDeletingAgent(null);
          }}
        />
      )}

      {deletingAgent && !deleteClones && !deleteCommits && (
        <ConfirmModal
          isOpen
          onClose={() => {
            setDeletingAgent(null);
            setDeleteError(null);
          }}
          onConfirm={() => handleDeleteConfirm()}
          title="Delete Agent"
          message={`Delete "${deletingAgent.displayName}"? This cannot be undone.`}
          confirmText="Delete"
          confirmButtonVariant="danger"
          isLoading={deleting}
          error={deleteError}
          confirmTestId="agent-delete-confirm"
        />
      )}
    </div>
  );
}
