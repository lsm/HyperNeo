import type { SpaceAgent } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { spaceAgentStore } from '../../lib/space-agent-store';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { EmptyState } from '../ui/EmptyState';

export interface SpaceAgentsPageProps {
  spaceId: string;
}

const PROTECTED_HANDLES = new Set(['space-manager', 'coordinator']);

interface TemplateOption {
  key: string;
  displayName: string;
}

function templateOptions(): TemplateOption[] {
  return spaceStore.agentTemplates.value;
}

export function SpaceAgentsPage({ spaceId }: SpaceAgentsPageProps) {
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

  useEffect(() => {
    void spaceAgentStore.selectSpace(spaceId);
    spaceStore.fetchTemplates().catch(() => {});
    return () => {
      spaceAgentStore.teardown();
    };
  }, [spaceId]);

  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  function openCreate() {
    setFormError(null);
    setEditing(null);
    setCreating(true);
  }

  function openEdit(agent: SpaceAgent) {
    setFormError(null);
    setCreating(false);
    setEditing(agent);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setFormError(null);
  }

  async function submitForm(event: Event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const field = (name: string) => String(data.get(name) ?? '').trim();

    if (editing && field('displayName') === '') {
      setFormError('Name is required');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await spaceAgentStore.update(editing.id, {
          displayName: field('displayName'),
          instructions: field('instructions'),
        });
      } else {
        const agent = await spaceAgentStore.create({
          spaceId,
          displayName: field('displayName') || undefined,
          handle: field('handle') || undefined,
          instructions: field('instructions') || undefined,
          templateKey: field('templateKey') || undefined,
        });
        setSelectedId(agent.id);
      }
      closeForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await spaceAgentStore.remove(deleting.id);
      if (selectedId === deleting.id) setSelectedId(null);
      setDeleting(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      setDeleteBusy(false);
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

      {!loading && agents.length === 0 && !creating && (
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
                      defaultValue=""
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
