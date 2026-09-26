import { useState, useEffect } from 'preact/hooks';
import type {
  Space,
  SpaceExportBundle,
  SpaceAutonomyLevel,
  SettingSource,
  SpaceWorkspace,
} from '@hyperneo/shared';
import { MAX_SPACE_CONCURRENT_TASKS, MIN_SPACE_CONCURRENT_TASKS } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager.ts';
import { globalSettings, connectionState } from '../../lib/state.ts';
import { spaceStore, SPACE_DELETE_TIMEOUT_MS } from '../../lib/space-store.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../../lib/runtime-capabilities.ts';
import { downloadBundle } from './export-import-utils.ts';
import { navigateToSpaces } from '../../lib/router.ts';
import { currentSpaceSettingsTabSignal, type SpaceSettingsTab } from '../../lib/signals.ts';
import { Button } from '../ui/Button.tsx';
import { AUTONOMY_LEVELS } from '../../lib/space-constants.ts';
import { AutonomyWorkflowSummary } from './AutonomyWorkflowSummary.tsx';
import { SpaceMcpSettings } from './SpaceMcpSettings.tsx';
import { SpaceExternalEventsSettings } from './SpaceExternalEventsSettings.tsx';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect.tsx';
import { SpaceTemplatesSection } from './SpaceTemplatesPanel.tsx';
import {
  SettingsDangerGroup,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '../settings/SettingsSection.tsx';
import { FORM_CONTROL_CLASS, FORM_CHECKBOX_CLASS, formControlClass } from '../ui/FormField';

interface SpaceSettingsProps {
  space: Space;
  tab?: SpaceSettingsTab;
}

const SETTING_SOURCE_OPTIONS: Array<[SettingSource, string, string]> = [
  ['user', 'User settings', '~/.claude/settings.json'],
  ['project', 'Project settings + CLAUDE.md', '.claude/settings.json'],
  ['local', 'Local settings', '.claude/settings.local.json'],
];

function getInheritedSettingSources(): SettingSource[] {
  return globalSettings.value?.settingSources ?? ['user', 'project', 'local'];
}

function workspaceTitle(workspace: SpaceWorkspace): string {
  if (workspace.label) return workspace.label;
  return workspace.path.split('/').filter(Boolean).at(-1) ?? workspace.path;
}

function rpcErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const workspaceInputClass =
  'rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50';

function SpaceWorkspacesList({ spaceId }: { spaceId: string }) {
  const [workspaces, setWorkspaces] = useState<SpaceWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    text: string;
    kind: 'action' | 'refresh';
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [newPath, setNewPath] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [savingLabelId, setSavingLabelId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());
  const connected = connectionState.value === 'connected';

  useEffect(() => {
    let cancelled = false;
    if (!connected) {
      setError(workspaces === null ? 'Failed to load workspaces: Not connected to server' : null);
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setError('Failed to load workspaces: Not connected to server');
      return;
    }
    hub
      .request<SpaceWorkspace[]>('space.workspace.list', { spaceId })
      .then((list) => {
        if (cancelled) return;
        setError(null);
        setActionError((current) => (current?.kind === 'refresh' ? null : current));
        setWorkspaces(list);
      })
      .catch((err) => {
        if (cancelled) return;
        if (workspaces === null) {
          setError(`Failed to load workspaces: ${rpcErrorMessage(err)}`);
        } else {
          setActionError((current) =>
            current?.kind === 'action'
              ? current
              : {
                  text: `Failed to refresh workspaces: ${rpcErrorMessage(err)}`,
                  kind: 'refresh',
                }
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, connected, reloadToken]);

  function reload() {
    setReloadToken((token) => token + 1);
  }

  function clearActionError() {
    setActionError((current) => (current?.kind === 'action' ? null : current));
  }

  function requireHub() {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) setActionError({ text: 'Not connected to server', kind: 'action' });
    return hub;
  }

  async function handleAdd() {
    if (adding) return;
    const path = newPath.trim();
    if (!path) {
      setActionError({ text: 'Workspace path is required', kind: 'action' });
      return;
    }
    const hub = requireHub();
    if (!hub) return;
    try {
      setAdding(true);
      clearActionError();
      const added = await hub.request<SpaceWorkspace>('space.workspace.add', {
        spaceId,
        path,
        label: newLabel.trim() || undefined,
      });
      setWorkspaces((current) => [...(current ?? []), added]);
      setNewPath('');
      setNewLabel('');
      reload();
    } catch (err) {
      setActionError({ text: rpcErrorMessage(err), kind: 'action' });
    } finally {
      setAdding(false);
    }
  }

  async function handleBrowse() {
    if (browsing) return;
    const hub = requireHub();
    if (!hub) return;
    try {
      setBrowsing(true);
      const picked = await hub.request<{ path: string | null }>('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      if (picked?.path) {
        setNewPath(picked.path);
        clearActionError();
      }
    } catch (err) {
      setActionError({
        text: err instanceof Error ? err.message : 'Failed to browse for folder',
        kind: 'action',
      });
    } finally {
      setBrowsing(false);
    }
  }

  async function handleSaveLabel() {
    if (!editing || savingLabelId) return;
    const { id, label } = editing;
    const trimmed = label.trim();
    const hub = requireHub();
    if (!hub) return;
    try {
      setSavingLabelId(id);
      clearActionError();
      await hub.request('space.workspace.updateLabel', {
        spaceId,
        workspaceId: id,
        label: trimmed,
      });
      setWorkspaces(
        (current) => current?.map((w) => (w.id === id ? { ...w, label: trimmed } : w)) ?? current
      );
      setEditing((current) => (current?.id === id ? null : current));
      reload();
    } catch (err) {
      setActionError({ text: rpcErrorMessage(err), kind: 'action' });
    } finally {
      setSavingLabelId(null);
    }
  }

  async function handleRemove(workspace: SpaceWorkspace) {
    if (removingId) return;
    if (!confirm(`Remove workspace "${workspaceTitle(workspace)}" (${workspace.path})?`)) return;
    const hub = requireHub();
    if (!hub) return;
    try {
      setRemovingId(workspace.id);
      clearActionError();
      await hub.request('space.workspace.remove', { spaceId, workspaceId: workspace.id });
      setWorkspaces((current) => current?.filter((w) => w.id !== workspace.id) ?? current);
      reload();
    } catch (err) {
      setActionError({ text: rpcErrorMessage(err), kind: 'action' });
    } finally {
      setRemovingId(null);
    }
  }

  const addOnEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  if (error) {
    return (
      <p class="text-sm text-danger-soft" data-testid="workspaces-error">
        {error}
      </p>
    );
  }

  if (!workspaces) return null;

  return (
    <div class="space-y-3">
      <div data-testid="workspaces-list">
        <SettingsGroup>
          {workspaces.length === 0 && (
            <div class="st-trow">
              <span class="st-trow-desc" data-testid="workspaces-empty">
                No workspaces registered for this space.
              </span>
            </div>
          )}
          {workspaces.map((workspace) => (
            <div
              key={workspace.id}
              class="flex items-center gap-3 px-4 py-3"
              data-testid="workspace-item"
            >
              <div class="min-w-0 flex-1">
                {editing !== null && editing.id === workspace.id ? (
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      value={editing.label}
                      data-testid="workspace-label-input"
                      onInput={(e) =>
                        setEditing({
                          id: workspace.id,
                          label: (e.target as HTMLInputElement).value,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSaveLabel();
                        } else if (e.key === 'Escape') {
                          setEditing(null);
                        }
                      }}
                      disabled={savingLabelId !== null}
                      class={formControlClass().replace('w-full', 'w-40')}
                    />
                    <button
                      type="button"
                      data-testid="workspace-label-save"
                      onClick={handleSaveLabel}
                      disabled={savingLabelId !== null}
                      class="text-xs text-accent hover:text-accent-soft disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      data-testid="workspace-label-cancel"
                      onClick={() => setEditing(null)}
                      disabled={savingLabelId !== null}
                      class="text-xs text-fg-muted hover:text-fg-soft disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div class="flex items-center gap-2">
                    <span class="truncate text-[13px] font-medium text-fg">
                      {workspaceTitle(workspace)}
                    </span>
                    {workspace.isPrimary && (
                      <span
                        class="st-chip-accent inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        data-testid="workspace-primary-badge"
                      >
                        Primary
                      </span>
                    )}
                  </div>
                )}
                <p class="truncate font-mono text-xs text-fg-muted">{workspace.path}</p>
              </div>
              {(editing === null || editing.id !== workspace.id) && (
                <div class="flex flex-shrink-0 items-center gap-3">
                  <button
                    type="button"
                    data-testid="workspace-edit-label"
                    onClick={() => {
                      setEditing({ id: workspace.id, label: workspace.label });
                      clearActionError();
                    }}
                    class="text-xs text-fg-muted hover:text-fg-soft"
                  >
                    Edit
                  </button>
                  {!workspace.isPrimary && (
                    <button
                      type="button"
                      data-testid="workspace-remove"
                      disabled={removingId === workspace.id}
                      onClick={() => handleRemove(workspace)}
                      class="text-xs text-danger hover:text-danger-soft disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <div class="st-addrow" data-testid="workspace-add-form">
            <input
              type="text"
              value={newPath}
              data-testid="workspace-add-path"
              placeholder="/absolute/path/to/repo"
              onInput={(e) => setNewPath((e.target as HTMLInputElement).value)}
              onKeyDown={addOnEnter}
              disabled={adding}
              class={cn(workspaceInputClass, 'min-w-0 flex-1 font-mono text-xs')}
            />
            <input
              type="text"
              value={newLabel}
              data-testid="workspace-add-label"
              placeholder="Label (optional)"
              onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
              onKeyDown={addOnEnter}
              disabled={adding}
              class={cn(workspaceInputClass, 'w-36')}
            />
            {nativeFolderPickerAvailable && (
              <button
                type="button"
                data-testid="workspace-add-browse"
                onClick={handleBrowse}
                disabled={adding || browsing}
                class="rounded-md border border-line px-2.5 py-1 text-[13px] text-fg-soft transition-colors hover:bg-fill-soft hover:text-fg disabled:opacity-50"
              >
                Browse
              </button>
            )}
            <Button type="button" size="sm" loading={adding} onClick={handleAdd}>
              Add
            </Button>
          </div>
        </SettingsGroup>
      </div>
      {actionError && (
        <p class="text-sm text-danger-soft" data-testid="workspaces-action-error">
          {actionError.text}
        </p>
      )}
    </div>
  );
}

export function SpaceSettings({ space, tab }: SpaceSettingsProps) {
  const activeTab = tab ?? currentSpaceSettingsTabSignal.value;
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? '');
  const [instructions, setInstructions] = useState(space.instructions ?? '');
  const [backgroundContext, setBackgroundContext] = useState(space.backgroundContext ?? '');
  const [autonomyLevel, setAutonomyLevel] = useState<SpaceAutonomyLevel>(space.autonomyLevel ?? 1);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(
    space.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS
  );
  const [defaultModel, setDefaultModel] = useState<string | undefined>(space.defaultModel);
  const [settingSources, setSettingSources] = useState<SettingSource[]>(
    space.settingSources ?? getInheritedSettingSources()
  );
  const hadExplicitSettingSources = space.settingSources !== undefined;
  const [clearSettingSources, setClearSettingSources] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [space.id]);

  useEffect(() => {
    setName(space.name);
    setDescription(space.description ?? '');
    setInstructions(space.instructions ?? '');
    setBackgroundContext(space.backgroundContext ?? '');
    setAutonomyLevel(space.autonomyLevel ?? 1);
    setMaxConcurrentTasks(space.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS);
    setDefaultModel(space.defaultModel);
    setSettingSources(space.settingSources ?? getInheritedSettingSources());
    setClearSettingSources(false);
    setSaveError(null);
  }, [
    space.id,
    space.name,
    space.description,
    space.instructions,
    space.backgroundContext,
    space.autonomyLevel,
    space.maxConcurrentTasks,
    space.defaultModel,
    space.settingSources,
  ]);

  const isDirty =
    name !== space.name ||
    description !== (space.description ?? '') ||
    instructions !== (space.instructions ?? '') ||
    backgroundContext !== (space.backgroundContext ?? '') ||
    autonomyLevel !== (space.autonomyLevel ?? 1) ||
    maxConcurrentTasks !== (space.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS) ||
    defaultModel !== space.defaultModel ||
    JSON.stringify(settingSources) !==
      JSON.stringify(space.settingSources ?? getInheritedSettingSources()) ||
    clearSettingSources;

  function resetChanges() {
    setName(space.name);
    setDescription(space.description ?? '');
    setInstructions(space.instructions ?? '');
    setBackgroundContext(space.backgroundContext ?? '');
    setAutonomyLevel(space.autonomyLevel ?? 1);
    setMaxConcurrentTasks(space.maxConcurrentTasks ?? MIN_SPACE_CONCURRENT_TASKS);
    setDefaultModel(space.defaultModel);
    setSettingSources(space.settingSources ?? getInheritedSettingSources());
    setClearSettingSources(false);
    setSaveError(null);
  }

  async function handleSave(e: Event) {
    e.preventDefault();
    if (!name.trim()) {
      setSaveError('Space name is required');
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setSaveError('Not connected to server');
      return;
    }
    try {
      setSaving(true);
      setSaveError(null);
      const updated = await hub.request<Space>('space.update', {
        id: space.id,
        name: name.trim(),
        description: description.trim() || undefined,
        instructions: instructions.trim() || undefined,
        backgroundContext: backgroundContext.trim() || undefined,
        autonomyLevel,
        maxConcurrentTasks,
        defaultModel: defaultModel || null,
        ...(clearSettingSources ||
        JSON.stringify(settingSources) !==
          JSON.stringify(space.settingSources ?? getInheritedSettingSources())
          ? { settingSources: clearSettingSources ? null : settingSources }
          : {}),
      });
      spaceStore.space.value = updated;
      toast.success('Space updated');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  async function exportBundle() {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Connection lost.');
      return;
    }
    try {
      const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.bundle', {
        spaceId: space.id,
      });
      downloadBundle(bundle, space.name, 'bundle');
      toast.success(`Bundle exported for "${space.name}"`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleArchive() {
    if (
      !confirm(
        `Archive "${space.name}"? The space will be hidden from the main list but can be restored later.`
      )
    ) {
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setIsArchiving(true);
      await hub.request('space.archive', { id: space.id });
      toast.success(`Space "${space.name}" archived`);
      navigateToSpaces();
    } catch (err) {
      toast.error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsArchiving(false);
    }
  }

  async function handleDelete() {
    if (
      !confirm(
        `Permanently delete "${space.name}"? This will remove all agents, workflows, tasks, and runs. This cannot be undone.`
      )
    ) {
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setIsDeleting(true);
      await hub.request('space.delete', { id: space.id }, { timeout: SPACE_DELETE_TIMEOUT_MS });
      toast.success(`Space "${space.name}" deleted`);
      navigateToSpaces();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsDeleting(false);
    }
  }

  const isFormTab = activeTab === 'general' || activeTab === 'runtime';

  if (activeTab === 'agent-templates') {
    return <SpaceTemplatesSection spaceId={space.id} />;
  }

  return (
    <div class="scrollbar-dark flex h-full min-h-0 flex-col overflow-y-auto py-4 pr-3">
      {isFormTab ? (
        <form onSubmit={handleSave}>
          {saveError && (
            <div class="mb-4 rounded-lg border border-danger/50 bg-danger/20 px-4 py-2 text-sm text-danger-soft">
              {saveError}
            </div>
          )}

          {activeTab === 'general' && (
            <>
              <SettingsSection
                title="General"
                description="Name the space and choose the default model for new work."
              >
                <SettingsGroup>
                  <SettingsRow label="Name">
                    <input
                      type="text"
                      value={name}
                      onInput={(e) => setName((e.target as HTMLInputElement).value)}
                      class={cn(FORM_CONTROL_CLASS, 'sm:w-80')}
                    />
                  </SettingsRow>
                  <SettingsRow
                    label="Default model"
                    description="Applied to new work in this space"
                  >
                    <WorkflowModelSelect
                      value={defaultModel}
                      onChange={(val) => setDefaultModel(val)}
                      testId="default-model-select"
                      className="w-full rounded-md border border-line bg-surface px-2.5 py-1 text-[13px] text-fg-soft focus:border-accent focus:outline-none sm:w-80"
                    />
                  </SettingsRow>
                  <SettingsRow label="Description" layout="stacked">
                    <textarea
                      value={description}
                      onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
                      placeholder="Brief description of this space..."
                      rows={2}
                      class={cn(FORM_CONTROL_CLASS, 'resize-none')}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </SettingsSection>

              <SettingsSection
                title="Workspaces"
                description="Repository paths this space works in. The primary workspace is the default location."
              >
                <SpaceWorkspacesList key={space.id} spaceId={space.id} />
              </SettingsSection>

              <SettingsSection
                title="Instructions"
                description="Persistent guidance that shapes every agent and task spawned from this space."
              >
                <SettingsGroup>
                  <SettingsRow label="Space instructions" layout="stacked">
                    <div>
                      <textarea
                        value={instructions}
                        onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
                        placeholder="e.g. Always use TypeScript strict mode. Prefer functional components..."
                        rows={7}
                        class={cn(FORM_CONTROL_CLASS, 'resize-y')}
                      />
                      <div class="st-charcount">{instructions.length} characters</div>
                    </div>
                  </SettingsRow>
                  <SettingsRow label="Background context" layout="stacked">
                    <div>
                      <textarea
                        value={backgroundContext}
                        onInput={(e) =>
                          setBackgroundContext((e.target as HTMLTextAreaElement).value)
                        }
                        placeholder="e.g. This project uses Bun + Hono backend, Preact frontend with Tailwind CSS..."
                        rows={7}
                        class={cn(FORM_CONTROL_CLASS, 'resize-y')}
                      />
                      <div class="st-charcount">{backgroundContext.length} characters</div>
                    </div>
                  </SettingsRow>
                </SettingsGroup>
              </SettingsSection>
            </>
          )}

          {activeTab === 'runtime' && (
            <SettingsSection
              title="Runtime"
              description="Control how independent the space is and which local settings its agents inherit."
            >
              <SettingsGroup>
                <SettingsRow label="Autonomy level" layout="stacked">
                  <div>
                    <div class="space-y-1">
                      {AUTONOMY_LEVELS.map(({ level, label, description }) => (
                        <button
                          key={level}
                          type="button"
                          onClick={() => setAutonomyLevel(level)}
                          data-testid={`autonomy-level-${level}`}
                          class={cn(
                            'w-full rounded-lg px-3 py-2 text-left transition-colors',
                            autonomyLevel === level
                              ? 'bg-fill text-fg'
                              : 'text-fg-muted hover:bg-fill-soft hover:text-fg-soft'
                          )}
                        >
                          <div class="flex items-center gap-3">
                            <span
                              class={cn(
                                'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold',
                                autonomyLevel === level
                                  ? 'bg-accent/20 text-accent-soft'
                                  : 'bg-fill-soft text-fg-muted'
                              )}
                            >
                              {level}
                            </span>
                            <div class="min-w-0">
                              <div class="text-sm font-medium">{label}</div>
                              <div class="text-xs text-fg-muted">{description}</div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                    <AutonomyWorkflowSummary
                      level={autonomyLevel}
                      workflows={spaceStore.workflows.value}
                      class="mt-2"
                    />
                  </div>
                </SettingsRow>
                <SettingsRow
                  label="Concurrent tasks"
                  description="Maximum tasks this space runs at once"
                >
                  <div class="flex items-center gap-3">
                    <input
                      type="range"
                      min={MIN_SPACE_CONCURRENT_TASKS}
                      max={MAX_SPACE_CONCURRENT_TASKS}
                      step={1}
                      value={maxConcurrentTasks}
                      data-testid="concurrent-tasks-slider"
                      onInput={(e) =>
                        setMaxConcurrentTasks(Number((e.target as HTMLInputElement).value))
                      }
                      class="h-2 w-40 cursor-pointer appearance-none rounded-full bg-fill-strong accent-accent"
                    />
                    <span
                      class="w-8 text-center font-mono text-sm tabular-nums text-fg-soft"
                      data-testid="concurrent-tasks-value"
                    >
                      {maxConcurrentTasks}
                    </span>
                  </div>
                </SettingsRow>
                <SettingsRow
                  label="Setting sources"
                  description="Choose which on-disk settings files agents load."
                  layout="stacked"
                >
                  <div>
                    {(hadExplicitSettingSources || clearSettingSources) && (
                      <div class="mb-1 flex items-center justify-end gap-2">
                        {hadExplicitSettingSources && !clearSettingSources && (
                          <button
                            type="button"
                            onClick={() => setClearSettingSources(true)}
                            class="shrink-0 text-xs text-accent hover:text-accent-soft"
                          >
                            Use defaults
                          </button>
                        )}
                        {clearSettingSources && (
                          <>
                            <span class="text-xs text-fg-muted">
                              Will revert to inherited defaults on save.
                            </span>
                            <button
                              type="button"
                              onClick={() => setClearSettingSources(false)}
                              class="text-xs text-accent hover:text-accent-soft"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    <div class="space-y-1">
                      {SETTING_SOURCE_OPTIONS.map(([source, label, detail]) => (
                        <label
                          key={source}
                          class="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-sm text-fg-soft hover:bg-fill-soft"
                        >
                          <input
                            type="checkbox"
                            checked={settingSources.includes(source)}
                            onChange={() => {
                              setSettingSources((prev) =>
                                prev.includes(source)
                                  ? prev.filter((s) => s !== source)
                                  : [...prev, source]
                              );
                            }}
                            disabled={clearSettingSources}
                            class={cn(FORM_CHECKBOX_CLASS, 'mt-0.5')}
                          />
                          <span class="min-w-0">
                            <span class="block">{label}</span>
                            <span class="block truncate text-xs text-fg-muted">{detail}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </SettingsRow>
              </SettingsGroup>
            </SettingsSection>
          )}

          {isDirty && (
            <div class="st-savebar">
              <span class="st-savebar-hint">Unsaved changes</span>
              <Button type="button" variant="secondary" size="sm" onClick={resetChanges}>
                Discard
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                Save Changes
              </Button>
            </div>
          )}
        </form>
      ) : (
        <>
          {activeTab === 'tools' && (
            <SettingsSection title="Tools" description="Enable MCP servers this space can use.">
              <SpaceMcpSettings spaceId={space.id} disabled={saving} />
            </SettingsSection>
          )}

          {activeTab === 'events' && (
            <SettingsSection
              title="Events"
              description="Wire GitHub and webhook events into this space."
            >
              <SpaceExternalEventsSettings spaceId={space.id} disabled={saving} />
            </SettingsSection>
          )}

          {activeTab === 'advanced' && (
            <>
              <SettingsSection
                title="Advanced"
                description="Download the space definition and inspect lightweight metadata."
              >
                <SettingsGroup>
                  <SettingsRow
                    label="Portable Space bundle"
                    description="Download all agents and workflows as a .hyperneo.json bundle."
                  >
                    <Button type="button" variant="secondary" size="sm" onClick={exportBundle}>
                      Export Bundle
                    </Button>
                  </SettingsRow>
                </SettingsGroup>
                <dl class="mt-4 grid gap-2 px-1 text-xs sm:grid-cols-3">
                  <div>
                    <dt class="text-fg-muted">Status</dt>
                    <dd class="mt-0.5 capitalize text-fg-soft">{space.status}</dd>
                  </div>
                  <div>
                    <dt class="text-fg-muted">Created</dt>
                    <dd class="mt-0.5 text-fg-soft">
                      {new Date(space.createdAt).toLocaleDateString()}
                    </dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-fg-muted">ID</dt>
                    <dd class="mt-0.5 truncate font-mono text-fg-muted">{space.id}</dd>
                  </div>
                </dl>
              </SettingsSection>

              <SettingsSection
                title={<span class="text-danger">Danger zone</span>}
                description="Destructive actions for this space. Archive is reversible; delete is permanent."
              >
                <SettingsDangerGroup>
                  <div class="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p class="text-[13px] font-medium text-fg">Archive space</p>
                      <p class="mt-0.5 text-xs text-fg-muted">
                        Hide from the main list. Can be restored later.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleArchive}
                      disabled={space.status === 'archived' || isArchiving}
                      loading={isArchiving}
                    >
                      Archive
                    </Button>
                  </div>
                  <div class="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p class="text-[13px] font-medium text-fg">Delete space</p>
                      <p class="mt-0.5 text-xs text-fg-muted">
                        Permanently remove this space and all its data.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={handleDelete}
                      disabled={isDeleting}
                      loading={isDeleting}
                    >
                      Delete
                    </Button>
                  </div>
                </SettingsDangerGroup>
              </SettingsSection>
            </>
          )}
        </>
      )}
    </div>
  );
}
