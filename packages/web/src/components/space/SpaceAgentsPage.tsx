import type {
  AgentModelPoolEntry,
  SpaceAgent,
  SpaceAgentAutonomyLevel,
  SettingSource,
  SpaceAgentStatus,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { spaceAgentStore } from '../../lib/space-agent-store';
import { spaceStore } from '../../lib/space-store';
import { ModelPoolEditor } from './ModelPoolEditor';
import { type ToolsSelection, ToolsEditor } from './ToolsEditor';
import { SettingSourcesEditor } from './SettingSourcesEditor';
import {
  differsFromBaseline,
  rebaseTemplateTools,
  templateToolsList,
  trackAddedTools,
  trackRemovedTools,
} from './template-tools';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { EmptyState } from '../ui/EmptyState';

export interface SpaceAgentsPageProps {
  spaceId: string;
  selectedHandle?: string | null;
}

const PROTECTED_HANDLES = new Set(['space-manager', 'coordinator']);
const EDITABLE_STATUSES: SpaceAgentStatus[] = ['active', 'paused', 'disabled'];
const UNSET_AUTONOMY = 'none';
const AUTONOMY_LEVELS = [1, 2, 3, 4, 5] as const;

type TemplateOption = SpaceLongHorizonAgentTemplate;

function poolFromAgent(agent: SpaceAgent): AgentModelPoolEntry[] {
  if (agent.modelPool && agent.modelPool.length > 0) return agent.modelPool;
  if (!agent.model) return [];
  return [
    {
      model: agent.model,
      provider: agent.provider ?? undefined,
      maxConcurrent: 1,
      weight: 100,
    },
  ];
}

function matchesSelectedHandle(agent: SpaceAgent, handle: string): boolean {
  if (agent.handle === handle) return true;
  return handle === 'coordinator' && PROTECTED_HANDLES.has(agent.handle);
}

export function usablePoolEntries(entries: AgentModelPoolEntry[]): AgentModelPoolEntry[] {
  return entries.filter((entry) => entry.model.trim() !== '');
}

export function createPoolFields(entries: AgentModelPoolEntry[]): {
  modelPool?: AgentModelPoolEntry[];
  model?: null;
  provider?: null;
} {
  const pool = usablePoolEntries(entries);
  if (pool.length === 0) return {};
  return { modelPool: pool, model: null, provider: null };
}

function statusOptions(handle: string): SpaceAgentStatus[] {
  return PROTECTED_HANDLES.has(handle) ? ['active'] : EDITABLE_STATUSES;
}

function templateOptions(): TemplateOption[] {
  return spaceStore.agentTemplates.value;
}

export function SpaceAgentsPage({ spaceId, selectedHandle }: SpaceAgentsPageProps) {
  const agents = spaceAgentStore.agents.value.filter((agent) => agent.status !== 'archived');
  const loading = spaceAgentStore.loading.value;
  const loadError = spaceAgentStore.error.value;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SpaceAgent | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SpaceAgent | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [formStatus, setFormStatus] = useState<SpaceAgentStatus>('active');
  const [formAutonomy, setFormAutonomy] = useState<string>('');
  const [formModelPool, setFormModelPool] = useState<AgentModelPoolEntry[]>([]);
  const [formTools, setFormTools] = useState<ToolsSelection>({ tools: [], toolsOverridden: false });
  const [formSettingSources, setFormSettingSources] = useState<SettingSource[] | null>(null);
  const [formTemplateKey, setFormTemplateKey] = useState<string>('');
  const [toolsExplicit, setToolsExplicit] = useState(false);
  const toolsBaselineRef = useRef<string[]>([]);
  const toolsRemovedRef = useRef<string[]>([]);
  const toolsAddedRef = useRef<string[]>([]);
  const activeSpaceRef = useRef(spaceId);
  const formGenerationRef = useRef(0);
  const appliedLinkRef = useRef<string | null>(null);
  const handledLinkRef = useRef<string | null>(null);
  const lastLinkRef = useRef<string | null>(null);
  const sawFirstLinkRef = useRef(false);
  const deleteGenerationRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  function resetViewState() {
    formGenerationRef.current += 1;
    setSelectedId(null);
    setCreating(false);
    setEditing(null);
    setSaving(false);
    setFormError(null);
    setDeleting(null);
    setDeleteBusy(false);
    setDeleteError(null);
    setFormStatus('active');
    setFormAutonomy('');
    setFormModelPool([]);
    setFormTools({ tools: [], toolsOverridden: false });
    setFormSettingSources(null);
    setFormTemplateKey('');
    setToolsExplicit(false);
    toolsBaselineRef.current = [];
    toolsRemovedRef.current = [];
    toolsAddedRef.current = [];
    appliedLinkRef.current = null;
    handledLinkRef.current = null;
    deleteGenerationRef.current += 1;
  }

  useEffect(() => {
    activeSpaceRef.current = spaceId;
    resetViewState();
    void spaceAgentStore.selectSpace(spaceId);

    let disposeTemplateRetry: (() => void) | undefined;
    spaceStore.fetchTemplates().catch(() => {
      disposeTemplateRetry = connectionManager.onceConnected(() => {
        spaceStore.fetchTemplates().catch(() => {});
      });
    });

    return () => {
      disposeTemplateRetry?.();
      spaceAgentStore.teardown();
    };
  }, [spaceId]);

  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  const deepLinked = selectedHandle
    ? (agents.find((agent) => matchesSelectedHandle(agent, selectedHandle)) ?? null)
    : null;
  const agentSignature = agents.map((agent) => `${agent.id}:${agent.handle}`).join('|');

  useEffect(() => {
    const link = selectedHandle ? `${spaceId}\u0000${selectedHandle}` : null;
    const previousLink = lastLinkRef.current;
    lastLinkRef.current = link;
    if (!sawFirstLinkRef.current) sawFirstLinkRef.current = true;
    else if (previousLink !== link) {
      formGenerationRef.current += 1;
      deleteGenerationRef.current += 1;
      closeForm();
      setSaving(false);
      setDeleting(null);
      setDeleteBusy(false);
      setDeleteError(null);
    }

    if (!link) {
      appliedLinkRef.current = null;
      handledLinkRef.current = null;
      return;
    }

    const matched = deepLinked && deepLinked.spaceId === spaceId ? deepLinked : null;
    if (!matched) {
      if (handledLinkRef.current === link) return;
      handledLinkRef.current = link;
      appliedLinkRef.current = null;
      setSelectedId(null);
      return;
    }

    if (appliedLinkRef.current === link) return;
    appliedLinkRef.current = link;
    handledLinkRef.current = link;
    setSelectedId(matched.id);
  }, [spaceId, selectedHandle, agentSignature]);
  const selectedTemplateSources = formTemplateKey
    ? (templateOptions().find((template) => template.key === formTemplateKey)?.settingSources ??
      null)
    : null;

  function openCreate() {
    formGenerationRef.current += 1;
    setFormError(null);
    setEditing(null);
    setCreating(true);
    setFormStatus('active');
    setFormAutonomy('');
    setFormModelPool([]);
    setFormTools({ tools: [], toolsOverridden: false });
    setFormSettingSources(null);
    setFormTemplateKey('');
    setToolsExplicit(false);
    toolsBaselineRef.current = [];
    toolsRemovedRef.current = [];
    toolsAddedRef.current = [];
  }

  function openEdit(agent: SpaceAgent) {
    formGenerationRef.current += 1;
    setFormError(null);
    setCreating(false);
    setEditing(agent);
    setFormStatus(agent.status);
    setFormAutonomy(agent.autonomyLevel ? String(agent.autonomyLevel) : '');
    setFormModelPool(poolFromAgent(agent));
    setFormTools({ tools: agent.tools ?? [], toolsOverridden: agent.tools !== null });
    setFormSettingSources(agent.settingSources ?? null);
    setFormTemplateKey('');
    setToolsExplicit(agent.tools !== null);
    toolsBaselineRef.current = [];
    toolsRemovedRef.current = [];
    toolsAddedRef.current = agent.tools ?? [];
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setFormError(null);
    setFormTemplateKey('');
  }

  async function submitForm(event: Event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const field = (name: string) => String(data.get(name) ?? '').trim();
    const autonomyChoice = formAutonomy;
    const autonomyLevel =
      autonomyChoice && autonomyChoice !== UNSET_AUTONOMY
        ? (Number(autonomyChoice) as SpaceAgentAutonomyLevel)
        : null;

    if (editing && field('displayName') === '') {
      setFormError('Name is required');
      return;
    }

    const submittedFor = spaceId;
    const submittedGeneration = formGenerationRef.current;
    const isCurrentSubmission = () =>
      activeSpaceRef.current === submittedFor && formGenerationRef.current === submittedGeneration;

    const submittedPool = usablePoolEntries(formModelPool);

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await spaceAgentStore.update(editing.id, {
          displayName: field('displayName'),
          instructions: field('instructions'),
          description: field('description') || null,
          status: formStatus,
          autonomyLevel,
          modelPool: submittedPool.length > 0 ? submittedPool : null,
          model: null,
          provider: null,
          tools: formTools.toolsOverridden ? formTools.tools : null,
          settingSources: formSettingSources,
        });
        if (!isCurrentSubmission()) return;
      } else {
        const agent = await spaceAgentStore.create({
          spaceId,
          displayName: field('displayName') || undefined,
          handle: field('handle') || undefined,
          instructions: field('instructions') || undefined,
          description: field('description') || undefined,
          autonomyLevel: autonomyChoice === '' ? undefined : autonomyLevel,
          ...createPoolFields(formModelPool),
          tools: formTools.toolsOverridden ? formTools.tools : undefined,
          settingSources: formSettingSources ?? undefined,
          templateKey: field('templateKey') || undefined,
        });
        if (!isCurrentSubmission()) return;
        setSelectedId(agent.id);
      }
      closeForm();
    } catch (err) {
      if (!isCurrentSubmission()) return;
      setFormError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      if (isCurrentSubmission()) setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const submittedFor = spaceId;
    const submittedGeneration = deleteGenerationRef.current;
    const isCurrentDelete = () =>
      activeSpaceRef.current === submittedFor &&
      deleteGenerationRef.current === submittedGeneration;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await spaceAgentStore.remove(deleting.id);
      if (!isCurrentDelete()) return;
      if (selectedIdRef.current === deleting.id) setSelectedId(null);
      setDeleting(null);
    } catch (err) {
      if (!isCurrentDelete()) return;
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      if (isCurrentDelete()) setDeleteBusy(false);
    }
  }

  return (
    <div class="flex h-full flex-col gap-4" data-testid="space-agents-page">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium text-fg">Agents</h2>
        <Button size="sm" onClick={openCreate} data-testid="new-agent-button">
          New agent
        </Button>
      </div>

      {loadError && (
        <p class="text-xs text-danger" data-testid="agents-load-error">
          {loadError}
        </p>
      )}

      {selectedHandle && !deepLinked && !loading && !loadError && agents.length > 0 && (
        <p class="text-xs text-fg-muted" data-testid="agent-deep-link-missing">
          No agent found for @{selectedHandle}.
        </p>
      )}

      {!loading && !loadError && agents.length === 0 && !creating && (
        <EmptyState
          title="No agents yet"
          description="Create an agent to start a conversation in this space."
          action={{ label: 'New agent', onClick: openCreate }}
        />
      )}

      <div class="flex min-h-0 flex-1 gap-4">
        <ul class="w-56 flex-shrink-0 space-y-1 overflow-y-auto" data-testid="agent-list">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                data-testid={`agent-row-${agent.handle}`}
                onClick={() => setSelectedId(agent.id)}
                class={`w-full rounded px-2 py-1.5 text-left text-xs ${
                  agent.id === selectedId ? 'bg-fill text-fg' : 'text-fg-soft hover:bg-fill-subtle'
                }`}
              >
                <span class="block truncate">{agent.displayName}</span>
                <span class="block truncate text-[11px] text-fg-faint">@{agent.handle}</span>
              </button>
            </li>
          ))}
        </ul>

        <div class="min-w-0 flex-1 overflow-y-auto">
          {(creating || editing) && (
            <form
              class="space-y-3"
              key={editing?.id ?? 'new'}
              onSubmit={submitForm}
              data-testid="agent-form"
            >
              <label class="block text-xs text-fg-soft">
                Name
                <input
                  class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                  name="displayName"
                  defaultValue={editing?.displayName ?? ''}
                  data-testid="agent-name-input"
                />
              </label>

              {!editing && (
                <>
                  <label class="block text-xs text-fg-soft">
                    Handle (optional)
                    <input
                      class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                      name="handle"
                      defaultValue=""
                      data-testid="agent-handle-input"
                    />
                  </label>

                  <label class="block text-xs text-fg-soft">
                    Start from template
                    <select
                      class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                      name="templateKey"
                      value={formTemplateKey}
                      onInput={(event) => {
                        const key = event.currentTarget.value;
                        const nextBaseline = templateToolsList(
                          templateOptions().find((candidate) => candidate.key === key)
                        );
                        const rebased = rebaseTemplateTools(
                          formTools.tools,
                          nextBaseline,
                          toolsExplicit,
                          toolsAddedRef.current,
                          toolsRemovedRef.current
                        );
                        toolsBaselineRef.current = nextBaseline;
                        setFormTemplateKey(key);
                        setFormTools({
                          tools: rebased,
                          toolsOverridden:
                            toolsExplicit || differsFromBaseline(rebased, nextBaseline),
                        });
                      }}
                      data-testid="agent-template-select"
                    >
                      <option value="">Blank agent</option>
                      {templateOptions().map((template) => (
                        <option key={template.key} value={template.key}>
                          {template.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              <label class="block text-xs text-fg-soft">
                Description
                <input
                  class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                  name="description"
                  defaultValue={editing?.description ?? ''}
                  data-testid="agent-description-input"
                />
              </label>

              {editing && (
                <label class="block text-xs text-fg-soft">
                  Status
                  <select
                    class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                    name="status"
                    value={formStatus}
                    onInput={(event) =>
                      setFormStatus(event.currentTarget.value as SpaceAgentStatus)
                    }
                    data-testid="agent-status-select"
                  >
                    {statusOptions(editing.handle).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label class="block text-xs text-fg-soft">
                Autonomy level
                <select
                  class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                  name="autonomyLevel"
                  value={formAutonomy}
                  onInput={(event) => setFormAutonomy(event.currentTarget.value)}
                  data-testid="agent-autonomy-select"
                >
                  <option value="">{editing ? 'Unset' : 'Template default'}</option>
                  {!editing && <option value={UNSET_AUTONOMY}>Unset</option>}
                  {AUTONOMY_LEVELS.map((value) => (
                    <option key={value} value={String(value)}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <div class="block text-xs text-fg-soft" data-testid="agent-model-pool-field">
                Models
                <div class="mt-1">
                  <ModelPoolEditor
                    mode="pool"
                    modelPool={formModelPool}
                    onModelPoolChange={setFormModelPool}
                  />
                </div>
              </div>

              <div data-testid="agent-tools-field">
                <ToolsEditor
                  tools={formTools.tools}
                  toolsOverridden={formTools.toolsOverridden}
                  onChange={(next, origin) => {
                    if (origin === 'preset') {
                      if (!next.toolsOverridden) {
                        setToolsExplicit(false);
                        toolsRemovedRef.current = [];
                        toolsAddedRef.current = [];
                        setFormTools({ tools: toolsBaselineRef.current, toolsOverridden: false });
                        return;
                      }
                      setToolsExplicit(true);
                      setFormTools(next);
                      return;
                    }
                    if (toolsExplicit) {
                      toolsAddedRef.current = trackAddedTools(
                        toolsAddedRef.current,
                        [],
                        next.tools
                      );
                      if (!differsFromBaseline(next.tools, toolsBaselineRef.current)) {
                        setToolsExplicit(false);
                        toolsRemovedRef.current = [];
                        toolsAddedRef.current = [];
                        setFormTools({
                          tools: toolsBaselineRef.current,
                          toolsOverridden: false,
                        });
                        return;
                      }
                      setFormTools({ tools: next.tools, toolsOverridden: true });
                      return;
                    }
                    toolsRemovedRef.current = trackRemovedTools(
                      toolsRemovedRef.current,
                      toolsBaselineRef.current,
                      next.tools
                    );
                    toolsAddedRef.current = trackAddedTools(
                      toolsAddedRef.current,
                      toolsBaselineRef.current,
                      next.tools
                    );
                    if (
                      toolsAddedRef.current.length === 0 &&
                      toolsRemovedRef.current.length === 0 &&
                      !differsFromBaseline(next.tools, toolsBaselineRef.current)
                    ) {
                      setToolsExplicit(false);
                      setFormTools({ tools: toolsBaselineRef.current, toolsOverridden: false });
                      return;
                    }
                    setFormTools({ tools: next.tools, toolsOverridden: true });
                  }}
                  manageScopedEntries
                  preservedScopedEntries={toolsAddedRef.current}
                />
              </div>

              <div data-testid="agent-setting-sources-field">
                <div class="mb-1 flex items-center justify-between">
                  <span class="text-xs text-fg-soft">
                    Setting sources
                    {formSettingSources === null && (
                      <span class="ml-2 text-fg-muted">(inherited)</span>
                    )}
                  </span>
                  {formSettingSources !== null && (
                    <button
                      type="button"
                      class="text-xs text-fg-muted hover:text-fg-soft"
                      data-testid="agent-setting-sources-reset"
                      onClick={() => setFormSettingSources(null)}
                    >
                      Reset to inherited
                    </button>
                  )}
                </div>
                <SettingSourcesEditor
                  value={formSettingSources ?? selectedTemplateSources}
                  onChange={(next) => setFormSettingSources(next)}
                />
              </div>

              <label class="block text-xs text-fg-soft">
                Instructions
                <textarea
                  class="mt-1 h-32 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                  name="instructions"
                  defaultValue={editing?.instructions ?? ''}
                  data-testid="agent-instructions-input"
                />
              </label>

              {formError && (
                <p class="text-xs text-danger" data-testid="agent-form-error">
                  {formError}
                </p>
              )}

              <div class="flex gap-2">
                <Button type="submit" size="sm" loading={saving} data-testid="agent-save-button">
                  {editing ? 'Save' : 'Create'}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {!creating && !editing && selected && (
            <div class="space-y-3" data-testid="agent-detail">
              <div>
                <h3 class="text-sm font-medium text-fg">{selected.displayName}</h3>
                <p class="text-xs text-fg-muted">@{selected.handle}</p>
              </div>
              <p class="whitespace-pre-wrap text-xs text-fg-soft">
                {selected.instructions || 'No instructions.'}
              </p>
              <div class="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => openEdit(selected)}>
                  Edit
                </Button>
                {!PROTECTED_HANDLES.has(selected.handle) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="agent-delete-button"
                    onClick={() => {
                      deleteGenerationRef.current += 1;
                      setDeleting(selected);
                      setDeleteError(null);
                    }}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {deleting && (
        <ConfirmModal
          isOpen
          title="Delete agent"
          message={`Delete "${deleting.displayName}"? This cannot be undone.`}
          confirmText="Delete"
          confirmButtonVariant="danger"
          isLoading={deleteBusy}
          error={deleteError}
          confirmTestId="confirm-delete-agent"
          onConfirm={confirmDelete}
          onClose={() => {
            if (deleteBusy) return;
            setDeleting(null);
            setDeleteError(null);
          }}
        />
      )}
    </div>
  );
}
