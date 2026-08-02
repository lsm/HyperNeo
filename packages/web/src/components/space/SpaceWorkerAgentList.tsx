/**
 * SpaceWorkerAgentList Component
 *
 * Displays persisted worker agent types configured for a Space.
 * - Agent cards: name, model, description preview
 * - "Create Worker Agent" button to open the editor
 * - Template drift badges and sync actions for seeded worker agents
 * - Delete confirmation; daemon blocks deletion when workflows reference the agent.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import type { SpaceWorkerAgentDriftReport, SpaceWorkerAgent } from '@hyperneo/shared';
import { SpaceAgentEditor } from './SpaceAgentEditor';
import { SpaceAgentPresetSyncDiffModal } from './SpaceAgentPresetSyncDiffModal';
import { connectionManager } from '../../lib/connection-manager';
import { toast } from '../../lib/toast';

/** Two-signal drift state for one agent, mirrored from the drift report. */
type AgentDriftState = { updateAvailable: boolean; customized: boolean };

interface AgentCardProps {
  agent: SpaceWorkerAgent;
  updateAvailable: boolean;
  customized: boolean;
  syncing: boolean;
  onEdit: (agent: SpaceWorkerAgent) => void;
  onDelete: (agent: SpaceWorkerAgent) => void;
  onSync: (agent: SpaceWorkerAgent) => void;
  onShowDiff: (agent: SpaceWorkerAgent) => void;
}

function AgentCard({
  agent,
  updateAvailable,
  customized,
  syncing,
  onEdit,
  onDelete,
  onSync,
  onShowDiff,
}: AgentCardProps) {
  const toolCount = agent.tools?.length ?? 0;
  const settingSources = agent.settingSources ?? [];
  const status = agent.status ?? 'active';

  return (
    <div class="group border-b border-white/10 py-3 last:border-b-0">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="truncate text-sm font-medium text-gray-100">{agent.name}</span>
            {status !== 'active' && (
              <span class="inline-flex flex-shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-400">
                {status}
              </span>
            )}
            {updateAvailable && (
              <span
                class="inline-flex flex-shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-300"
                title={`A newer version of the "${agent.templateName}" template is available. Apply it to bring this agent up to date.`}
              >
                Update available
              </span>
            )}
            {customized && (
              <span
                class="inline-flex flex-shrink-0 items-center rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-400"
                title={
                  updateAvailable
                    ? 'This agent has local edits on top of its template — review the diff before applying the update.'
                    : "You've customized this agent from its template. No action needed."
                }
              >
                Customized
              </span>
            )}
          </div>
          {agent.handle && <p class="mt-0.5 text-xs text-gray-600 font-mono">{agent.handle}</p>}
          {agent.description && (
            <p class="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{agent.description}</p>
          )}
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
            <span class="font-mono text-gray-500">{agent.model || 'Default model'}</span>
            {agent.thinkingLevel && <span>{agent.thinkingLevel}</span>}
            {settingSources.length > 0 && <span>{settingSources.join(', ')}</span>}
            {toolCount > 0 && <span>{toolCount} tools</span>}
            {agent.tools?.slice(0, 3).map((tool) => (
              <span key={tool} class="rounded border border-white/10 px-1.5 py-0.5 text-gray-500">
                {tool}
              </span>
            ))}
          </div>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          {updateAvailable && (
            <>
              {customized ? (
                <button
                  type="button"
                  onClick={() => onShowDiff(agent)}
                  class="rounded-md px-2 py-1 text-xs text-amber-300 transition-colors hover:bg-white/5 hover:text-amber-200"
                  title="This agent has local edits. Review the diff before applying the template update."
                >
                  Review diff
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onShowDiff(agent)}
                    class="rounded-md px-2 py-1 text-xs text-amber-300 transition-colors hover:bg-white/5 hover:text-amber-200"
                    title="Preview what the template update would change"
                  >
                    Diff
                  </button>
                  <button
                    type="button"
                    onClick={() => onSync(agent)}
                    disabled={syncing}
                    class="rounded-md px-2 py-1 text-xs text-amber-300 transition-colors hover:bg-white/5 hover:text-amber-200 disabled:opacity-50"
                    title="Apply the template update (no local edits to lose)"
                  >
                    {syncing ? 'Applying…' : 'Apply'}
                  </button>
                </>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => onEdit(agent)}
            class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-300"
            aria-label={`Edit ${agent.name}`}
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
            onClick={() => onDelete(agent)}
            class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-red-400"
            aria-label={`Delete ${agent.name}`}
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
    </div>
  );
}

function PlusIcon() {
  return (
    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
      />
    </svg>
  );
}

export function SpaceWorkerAgentList() {
  const agents = spaceStore.agents.value;
  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => a.name.localeCompare(b.name)),
    [agents]
  );
  const loading = spaceStore.loading.value;
  const spaceId = spaceStore.spaceId.value;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<SpaceWorkerAgent | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<SpaceWorkerAgent | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncingAgent, setSyncingAgent] = useState<SpaceWorkerAgent | null>(null);
  const [diffAgent, setDiffAgent] = useState<SpaceWorkerAgent | null>(null);

  // Drift detection: per-agent two-signal state (updateAvailable / customized).
  // Empty until the first successful drift report fetch — agents absent from
  // the map render without a badge or action (the safe default when the daemon
  // hasn't responded yet).
  const [agentDrift, setAgentDrift] = useState<Map<string, AgentDriftState>>(new Map());
  const [syncingAgentId, setSyncingAgentId] = useState<string | null>(null);

  // Re-fetch drift report whenever the agent set changes. We watch a
  // concatenated key of (id, updatedAt) so the effect fires for adds,
  // removes, and edits — but not for unrelated re-renders.
  const driftKey = agents
    .map((a) => `${a.id}:${a.updatedAt}`)
    .sort()
    .join('|');

  useEffect(() => {
    setEditorOpen(false);
    setEditingAgent(null);
    setDeletingAgent(null);
    setDeleteError(null);
    setSyncingAgent(null);
    setDiffAgent(null);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;

    let cancelled = false;
    hub
      .request<{ report: SpaceWorkerAgentDriftReport }>('spaceAgent.getDriftReport', { spaceId })
      .then((result) => {
        if (cancelled) return;
        const next = new Map<string, AgentDriftState>();
        for (const entry of result.report.agents) {
          next.set(entry.agentId, {
            updateAvailable: entry.updateAvailable,
            customized: entry.customized,
          });
        }
        setAgentDrift(next);
      })
      .catch(() => {
        // Drift detection is best-effort — silently swallow errors so
        // list rendering never depends on the report succeeding.
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driftKey captures the list identity
  }, [spaceId, driftKey]);

  // Clear drift state for an agent eagerly so the badges disappear before the
  // next refresh cycle. The spaceAgent.updated event re-triggers the drift
  // effect and reconciles authoritatively. Shared by the quick "Apply" confirm
  // path and the diff modal's "Apply update".
  const clearDriftFor = (agentId: string) => {
    setAgentDrift((prev) => {
      if (!prev.has(agentId)) return prev;
      const next = new Map(prev);
      next.delete(agentId);
      return next;
    });
  };

  const handleSyncConfirm = async () => {
    if (!spaceId || !syncingAgent) return;
    const agent = syncingAgent;
    setSyncingAgentId(agent.id);
    try {
      await spaceStore.syncAgentFromTemplate(agent.id);
      clearDriftFor(agent.id);
      setSyncingAgent(null);
      toast.success(`"${agent.name}" updated from template`);
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncingAgentId((current) => (current === agent.id ? null : current));
    }
  };

  const handleShowDiff = (agent: SpaceWorkerAgent) => {
    setDiffAgent(agent);
  };

  const handleDiffSynced = (agent: SpaceWorkerAgent) => {
    clearDriftFor(agent.id);
  };

  const handleEdit = (agent: SpaceWorkerAgent) => {
    setEditingAgent(agent);
    setEditorOpen(true);
  };

  const handleCreate = () => {
    setEditingAgent(null);
    setEditorOpen(true);
  };

  const handleEditorClose = () => {
    setEditorOpen(false);
    setEditingAgent(null);
  };

  const handleDeleteClick = (agent: SpaceWorkerAgent) => {
    setDeletingAgent(agent);
    setDeleteError(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingAgent) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await spaceStore.deleteAgent(deletingAgent.id);
      setDeletingAgent(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete agent');
    } finally {
      setDeleting(false);
    }
  };

  // Workflow reference check removed: SpaceWorkflowSummary no longer includes
  // node/agent details. The daemon still blocks deletion of in-use agents.

  const existingAgentNames = sortedAgents
    .filter((a) => a.id !== editingAgent?.id)
    .map((a) => a.name);

  if (loading) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center">
          <span class="text-xs text-gray-600 animate-pulse">Loading agents...</span>
        </div>
      </div>
    );
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="mb-3 flex flex-shrink-0 items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3">
        <div class="flex min-w-0 items-start gap-3">
          <div class="mt-0.5 h-8 w-1 flex-shrink-0 rounded-full bg-blue-400/70" />
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wider text-gray-300">
              Worker Agents · {sortedAgents.length} configured
            </p>
            <p class="mt-1 text-xs text-gray-500">
              Reusable worker agent types available to workflows in this space. Edit their model,
              tools, setting sources, and standing instructions.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={handleCreate} icon={<PlusIcon />}>
          Create Worker Agent
        </Button>
      </div>

      {/* Agent list or empty state */}
      {sortedAgents.length === 0 ? (
        <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <div class="w-10 h-10 rounded-full bg-dark-800 flex items-center justify-center mb-3">
            <AgentIcon />
          </div>
          <p class="text-sm text-gray-400 font-medium">No worker agents configured.</p>
          <p class="text-xs text-gray-600 mt-1">
            Create a worker agent or seed one from a built-in template.
          </p>
          <div class="mt-4">
            <Button size="sm" variant="secondary" onClick={handleCreate}>
              Create Worker Agent
            </Button>
          </div>
        </div>
      ) : (
        <div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto pr-3">
          <div class="min-h-[calc(100%+1px)]">
            {sortedAgents.map((agent) => {
              const drift = agentDrift.get(agent.id);
              return (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  updateAvailable={drift?.updateAvailable ?? false}
                  customized={drift?.customized ?? false}
                  syncing={syncingAgentId === agent.id}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                  onSync={setSyncingAgent}
                  onShowDiff={handleShowDiff}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Editor Modal */}
      {editorOpen && (
        <SpaceAgentEditor
          agent={editingAgent}
          existingAgentNames={existingAgentNames}
          onSave={handleEditorClose}
          onCancel={handleEditorClose}
        />
      )}

      {syncingAgent && (
        <ConfirmModal
          isOpen
          onClose={() => setSyncingAgent(null)}
          onConfirm={handleSyncConfirm}
          title="Apply template update"
          message={`Apply the latest "${syncingAgent.templateName ?? 'template'}" template to "${syncingAgent.name}"? This updates its description, tools, and custom prompt to match the current template.`}
          confirmText="Apply update"
          confirmButtonVariant="primary"
          isLoading={syncingAgentId === syncingAgent.id}
        />
      )}

      {diffAgent && (
        <SpaceAgentPresetSyncDiffModal
          agent={diffAgent}
          onClose={() => setDiffAgent(null)}
          onSynced={handleDiffSynced}
        />
      )}

      {/* Delete confirmation: daemon blocks agents still referenced by workflows. */}
      {deletingAgent && (
        <ConfirmModal
          isOpen
          onClose={() => {
            setDeletingAgent(null);
            setDeleteError(null);
          }}
          onConfirm={handleDeleteConfirm}
          title="Delete Worker Agent"
          message={`Are you sure you want to delete "${deletingAgent.name}"? This action cannot be undone. If workflows still reference this worker agent, deletion will be blocked.`}
          confirmText="Delete"
          confirmButtonVariant="danger"
          isLoading={deleting}
          error={deleteError}
        />
      )}
    </div>
  );
}
