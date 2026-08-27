import type { ComponentChildren } from 'preact';
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
import { spaceStore } from '../../lib/space-store.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../../lib/runtime-capabilities.ts';
import { downloadBundle } from './export-import-utils.ts';
import { navigateToSpaces } from '../../lib/router.ts';
import { Button } from '../ui/Button.tsx';
import { AUTONOMY_LEVELS } from '../../lib/space-constants.ts';
import { AutonomyWorkflowSummary } from './AutonomyWorkflowSummary.tsx';
import { SpaceMcpSettings } from './SpaceMcpSettings.tsx';
import { SpaceExternalEventsSettings } from './SpaceExternalEventsSettings.tsx';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect.tsx';

interface SpaceSettingsProps {
  space: Space;
}

interface SettingsBlockProps {
  title: string;
  description: string;
  children: ComponentChildren;
  tone?: 'default' | 'danger';
}

function SettingsBlock({ title, description, children, tone = 'default' }: SettingsBlockProps) {
  return (
    <section
      class={cn(
        'grid gap-4 rounded-lg border p-4 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-6',
        tone === 'danger' ? 'border-red-900/40 bg-red-950/10' : 'border-white/10 bg-white/[0.025]'
      )}
    >
      <div>
        <h3
          class={cn(
            'text-xs font-semibold uppercase tracking-wider',
            tone === 'danger' ? 'text-red-400' : 'text-gray-400'
          )}
        >
          {title}
        </h3>
        <p class="mt-1 text-xs leading-5 text-gray-400">{description}</p>
      </div>
      <div class="min-w-0">{children}</div>
    </section>
  );
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

const inputClass =
  'rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none';

function SpaceWorkspacesList({ spaceId }: { spaceId: string }) {
  const [workspaces, setWorkspaces] = useState<SpaceWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
        setActionError(null);
        setWorkspaces(list);
      })
      .catch((err) => {
        if (cancelled) return;
        if (workspaces === null) {
          setError(`Failed to load workspaces: ${rpcErrorMessage(err)}`);
        } else {
          setActionError(`Failed to refresh workspaces: ${rpcErrorMessage(err)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, connected, reloadToken]);

  function reload() {
    setReloadToken((token) => token + 1);
  }

  function requireHub() {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) setActionError('Not connected to server');
    return hub;
  }

  async function handleAdd() {
    if (adding) return;
    const path = newPath.trim();
    if (!path) {
      setActionError('Workspace path is required');
      return;
    }
    const hub = requireHub();
    if (!hub) return;
    try {
      setAdding(true);
      setActionError(null);
      await hub.request('space.workspace.add', {
        spaceId,
        path,
        label: newLabel.trim() || undefined,
      });
      setNewPath('');
      setNewLabel('');
      reload();
    } catch (err) {
      setActionError(rpcErrorMessage(err));
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
        setActionError(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to browse for folder');
    } finally {
      setBrowsing(false);
    }
  }

  async function handleSaveLabel() {
    if (!editing || savingLabelId) return;
    const { id, label } = editing;
    const hub = requireHub();
    if (!hub) return;
    try {
      setSavingLabelId(id);
      setActionError(null);
      await hub.request('space.workspace.updateLabel', {
        spaceId,
        workspaceId: id,
        label: label.trim(),
      });
      setEditing((current) => (current?.id === id ? null : current));
      reload();
    } catch (err) {
      setActionError(rpcErrorMessage(err));
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
      setActionError(null);
      await hub.request('space.workspace.remove', { spaceId, workspaceId: workspace.id });
      reload();
    } catch (err) {
      setActionError(rpcErrorMessage(err));
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
      <p class="text-sm text-red-300" data-testid="workspaces-error">
        {error}
      </p>
    );
  }

  if (!workspaces) return null;

  return (
    <div class="space-y-3">
      {workspaces.length === 0 ? (
        <p class="text-sm text-gray-400" data-testid="workspaces-empty">
          No workspaces registered for this space.
        </p>
      ) : (
        <ul class="space-y-2" data-testid="workspaces-list">
          {workspaces.map((workspace) => (
            <li
              key={workspace.id}
              class="flex items-center gap-3 rounded-lg border border-white/10 bg-dark-850 px-3 py-2"
              data-testid="workspace-item"
            >
              <div class="min-w-0 flex-1">
                {editing?.id === workspace.id ? (
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
                      class="w-40 rounded border border-white/10 bg-dark-850 px-2 py-1 text-sm text-gray-100 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                    />
                    <button
                      type="button"
                      data-testid="workspace-label-save"
                      onClick={handleSaveLabel}
                      disabled={savingLabelId !== null}
                      class="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      data-testid="workspace-label-cancel"
                      onClick={() => setEditing(null)}
                      disabled={savingLabelId !== null}
                      class="text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div class="flex items-center gap-2">
                    <span class="truncate text-sm font-medium text-gray-200">
                      {workspaceTitle(workspace)}
                    </span>
                    {workspace.isPrimary && (
                      <span
                        class="flex-shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-300"
                        data-testid="workspace-primary-badge"
                      >
                        Primary
                      </span>
                    )}
                  </div>
                )}
                <p class="truncate font-mono text-xs text-gray-400">{workspace.path}</p>
              </div>
              {editing?.id !== workspace.id && (
                <div class="flex flex-shrink-0 items-center gap-3">
                  <button
                    type="button"
                    data-testid="workspace-edit-label"
                    onClick={() => {
                      setEditing({ id: workspace.id, label: workspace.label });
                      setActionError(null);
                    }}
                    class="text-xs text-gray-400 hover:text-gray-200"
                  >
                    Edit
                  </button>
                  {!workspace.isPrimary && (
                    <button
                      type="button"
                      data-testid="workspace-remove"
                      disabled={removingId === workspace.id}
                      onClick={() => handleRemove(workspace)}
                      class="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div class="flex flex-wrap items-center gap-2" data-testid="workspace-add-form">
        <input
          type="text"
          value={newPath}
          data-testid="workspace-add-path"
          placeholder="/absolute/path/to/repo"
          onInput={(e) => setNewPath((e.target as HTMLInputElement).value)}
          onKeyDown={addOnEnter}
          disabled={adding}
          class={`min-w-0 flex-1 font-mono text-xs disabled:opacity-50 ${inputClass}`}
        />
        <input
          type="text"
          value={newLabel}
          data-testid="workspace-add-label"
          placeholder="Label (optional)"
          onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
          onKeyDown={addOnEnter}
          disabled={adding}
          class={`w-36 disabled:opacity-50 ${inputClass}`}
        />
        {nativeFolderPickerAvailable && (
          <button
            type="button"
            data-testid="workspace-add-browse"
            onClick={handleBrowse}
            disabled={adding || browsing}
            class="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition-colors hover:bg-white/5 hover:text-gray-100 disabled:opacity-50"
          >
            Browse
          </button>
        )}
        <Button type="button" size="sm" loading={adding} onClick={handleAdd}>
          Add
        </Button>
      </div>
      {actionError && (
        <p class="text-sm text-red-300" data-testid="workspaces-action-error">
          {actionError}
        </p>
      )}
    </div>
  );
}

export function SpaceSettings({ space }: SpaceSettingsProps) {
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
      await hub.request('space.delete', { id: space.id });
      toast.success(`Space "${space.name}" deleted`);
      navigateToSpaces();
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div class="scrollbar-dark flex h-full min-h-0 flex-col overflow-y-auto py-4 pr-3">
      <div class="min-h-[calc(100%+1px)] space-y-4">
        <form onSubmit={handleSave} class="space-y-4">
          {saveError && (
            <div class="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-2 text-sm text-red-300">
              {saveError}
            </div>
          )}

          <SettingsBlock
            title="Basics"
            description="Name the space and choose the default model for new work."
          >
            <div class="grid gap-4 lg:grid-cols-2">
              <div>
                <label class="mb-1 block text-xs font-medium text-gray-400">Name</label>
                <input
                  type="text"
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                  class="w-full rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-gray-400">Default model</label>
                <WorkflowModelSelect
                  value={defaultModel}
                  onChange={(val) => setDefaultModel(val)}
                  testId="default-model-select"
                  className="w-full rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div class="lg:col-span-2">
                <label class="mb-1 block text-xs font-medium text-gray-400">
                  Description <span class="text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
                  placeholder="Brief description of this space..."
                  rows={2}
                  class="w-full resize-none rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          </SettingsBlock>

          <SettingsBlock
            title="Workspaces"
            description="Repository paths this space works in. The primary workspace is the default location."
          >
            <SpaceWorkspacesList key={space.id} spaceId={space.id} />
          </SettingsBlock>

          <SettingsBlock
            title="Instructions"
            description="Persistent guidance that shapes every agent and task spawned from this space."
          >
            <div class="grid gap-4 xl:grid-cols-2">
              <div>
                <label class="mb-1 block text-xs font-medium text-gray-400">
                  Space instructions <span class="text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={instructions}
                  onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
                  placeholder="e.g. Always use TypeScript strict mode. Prefer functional components..."
                  rows={7}
                  class="w-full resize-y rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                />
                <div class="mt-0.5 text-right text-xs text-gray-400">
                  {instructions.length} characters
                </div>
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-gray-400">
                  Background context <span class="text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={backgroundContext}
                  onInput={(e) => setBackgroundContext((e.target as HTMLTextAreaElement).value)}
                  placeholder="e.g. This project uses Bun + Hono backend, Preact frontend with Tailwind CSS..."
                  rows={7}
                  class="w-full resize-y rounded-lg border border-white/10 bg-dark-850 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                />
                <div class="mt-0.5 text-right text-xs text-gray-400">
                  {backgroundContext.length} characters
                </div>
              </div>
            </div>
          </SettingsBlock>

          <SettingsBlock
            title="Runtime"
            description="Control how independent the space is and which local settings its agents inherit."
          >
            <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div>
                <label class="mb-1 block text-xs font-medium text-gray-400">Autonomy level</label>
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
                          ? 'bg-white/10 text-gray-100'
                          : 'text-gray-400 hover:bg-white/5 hover:text-gray-300'
                      )}
                    >
                      <div class="flex items-center gap-3">
                        <span
                          class={cn(
                            'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold',
                            autonomyLevel === level
                              ? 'bg-blue-500/20 text-blue-300'
                              : 'bg-white/5 text-gray-400'
                          )}
                        >
                          {level}
                        </span>
                        <div class="min-w-0">
                          <div class="text-sm font-medium">{label}</div>
                          <div class="text-xs text-gray-400">{description}</div>
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

              <div class="space-y-5">
                <div>
                  <label class="mb-1 block text-xs font-medium text-gray-400">
                    Concurrent tasks
                  </label>
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
                      class="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-dark-700 accent-blue-500"
                    />
                    <span
                      class="w-8 text-center font-mono text-sm tabular-nums text-gray-200"
                      data-testid="concurrent-tasks-value"
                    >
                      {maxConcurrentTasks}
                    </span>
                  </div>
                </div>

                <div>
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <label class="block text-xs font-medium text-gray-400">Setting sources</label>
                      <p class="mt-1 text-xs leading-5 text-gray-400">
                        Choose which on-disk settings files agents load.
                      </p>
                    </div>
                    {hadExplicitSettingSources && !clearSettingSources && (
                      <button
                        type="button"
                        onClick={() => setClearSettingSources(true)}
                        class="shrink-0 text-xs text-blue-400 hover:text-blue-300"
                      >
                        Use defaults
                      </button>
                    )}
                  </div>
                  {clearSettingSources && (
                    <div class="mt-2 flex items-center gap-2">
                      <span class="text-xs text-gray-400">
                        Will revert to inherited defaults on save.
                      </span>
                      <button
                        type="button"
                        onClick={() => setClearSettingSources(false)}
                        class="text-xs text-blue-400 hover:text-blue-300"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <div class="mt-3 space-y-1">
                    {SETTING_SOURCE_OPTIONS.map(([source, label, detail]) => (
                      <label
                        key={source}
                        class="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-sm text-gray-300 hover:bg-white/5"
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
                          class="mt-0.5 h-4 w-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
                        />
                        <span class="min-w-0">
                          <span class="block">{label}</span>
                          <span class="block truncate text-xs text-gray-400">{detail}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </SettingsBlock>

          {isDirty && (
            <div class="sticky bottom-0 z-10 flex justify-end gap-2 rounded-lg border border-white/10 bg-dark-900/95 px-3 py-3 backdrop-blur">
              <Button type="button" variant="secondary" size="sm" onClick={resetChanges}>
                Discard
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                Save Changes
              </Button>
            </div>
          )}
        </form>

        <SettingsBlock
          title="Tools"
          description="Enable MCP servers and wire external events into this space."
        >
          <div class="space-y-5">
            <SpaceMcpSettings spaceId={space.id} disabled={saving} />
            <div class="border-t border-white/10 pt-4">
              <SpaceExternalEventsSettings spaceId={space.id} disabled={saving} />
            </div>
          </div>
        </SettingsBlock>

        <SettingsBlock
          title="Export"
          description="Download the space definition and inspect lightweight metadata."
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-sm text-gray-300">Portable Space bundle</p>
              <p class="mt-0.5 text-xs text-gray-400">
                Download all agents and workflows as a <span class="font-mono">.hyperneo.json</span>{' '}
                bundle.
              </p>
            </div>
            <button
              type="button"
              onClick={exportBundle}
              class="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition-colors hover:bg-white/5 hover:text-gray-100"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Export Bundle
            </button>
          </div>
          <dl class="mt-4 grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt class="text-gray-400">Status</dt>
              <dd class="mt-0.5 capitalize text-gray-300">{space.status}</dd>
            </div>
            <div>
              <dt class="text-gray-400">Created</dt>
              <dd class="mt-0.5 text-gray-300">{new Date(space.createdAt).toLocaleDateString()}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-gray-400">ID</dt>
              <dd class="mt-0.5 truncate font-mono text-gray-400">{space.id}</dd>
            </div>
          </dl>
        </SettingsBlock>

        <SettingsBlock
          title="Danger"
          description="Destructive actions for this space. Archive is reversible; delete is permanent."
          tone="danger"
        >
          <div class="divide-y divide-red-900/30 rounded-lg border border-red-900/30">
            <div class="flex items-center justify-between gap-4 px-3 py-3">
              <div>
                <p class="text-sm text-gray-300">Archive space</p>
                <p class="mt-0.5 text-xs text-gray-400">
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

            <div class="flex items-center justify-between gap-4 px-3 py-3">
              <div>
                <p class="text-sm text-gray-300">Delete space</p>
                <p class="mt-0.5 text-xs text-gray-400">
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
          </div>
        </SettingsBlock>
      </div>
    </div>
  );
}
