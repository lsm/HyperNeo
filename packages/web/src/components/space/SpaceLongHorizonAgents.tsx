import type { SpaceLongHorizonAgent, SpaceLongHorizonAgentTemplate } from '@neokai/shared';
import { useEffect, useState } from 'preact/hooks';
import { navigateToSpaceSession } from '../../lib/router';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';

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

// ── Agent editor ─────────────────────────────────────────────────────────────

/** Returns the next free handle: base → base-2 → base-3 … */
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
        });
      } else {
        await spaceStore.createLongHorizonAgent({
          handle: handle.trim(),
          displayName: displayName.trim(),
          templateKey: template?.key ?? null,
          instructions: instructions.trim(),
          autonomyLevel: autonomyLevel as 1 | 2 | 3 | 4 | 5 | null,
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
    <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4">
      <div class="w-full max-w-lg rounded-xl border border-white/10 bg-dark-900 shadow-2xl">
        <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <p class="text-sm font-semibold text-gray-100">
            {isEdit
              ? `Edit ${agent?.displayName}`
              : `New agent${template ? ` · ${template.displayName}` : ''}`}
          </p>
          <button
            type="button"
            onClick={onCancel}
            class="rounded p-1 text-gray-400 hover:text-gray-300 hover:bg-white/5"
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
        <div class="p-4 space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1">Name</label>
              <input
                type="text"
                value={displayName}
                onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500/50 focus:outline-none"
                placeholder="e.g. Release Manager"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1">Handle</label>
              <input
                type="text"
                value={handle}
                disabled={isEdit}
                onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
                class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500/50 focus:outline-none disabled:opacity-50"
                placeholder="e.g. release-manager"
              />
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Instructions</label>
            <textarea
              value={instructions}
              onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)}
              rows={5}
              class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500/50 focus:outline-none resize-none"
              placeholder="What should this agent do?"
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1">Autonomy level</label>
            <div class="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setAutonomyLevel(autonomyLevel === level ? null : level)}
                  class={`flex-1 rounded py-1 text-xs font-medium transition-colors ${
                    autonomyLevel === level
                      ? 'bg-blue-600 text-white'
                      : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-300'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
            {autonomyLevel && (
              <p class="mt-1 text-xs text-gray-400">{AUTONOMY_LABELS[autonomyLevel]}</p>
            )}
          </div>
          {error && <p class="text-xs text-red-400">{error}</p>}
        </div>
        <div class="flex justify-end gap-2 px-4 py-3 border-t border-white/10">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Agent card ────────────────────────────────────────────────────────────────

interface AgentCardProps {
  agent: SpaceLongHorizonAgent;
  spaceId: string;
  reminderCount: number;
  onEdit: () => void;
  onDelete: () => void;
}

function AgentCard({ agent, spaceId, reminderCount, onEdit, onDelete }: AgentCardProps) {
  const coordinator = isCoordinator(agent);
  const statusColors: Record<string, string> = {
    active: 'bg-green-500',
    paused: 'bg-amber-500',
    disabled: 'bg-gray-600',
    archived: 'bg-gray-700',
  };

  const sessionId = agent.sessionId ?? (coordinator ? `space:chat:${spaceId}` : null);

  return (
    <div
      role={sessionId ? 'button' : undefined}
      tabIndex={sessionId ? 0 : undefined}
      onClick={sessionId ? () => navigateToSpaceSession(spaceId, sessionId) : undefined}
      onKeyDown={
        sessionId
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') navigateToSpaceSession(spaceId, sessionId);
            }
          : undefined
      }
      class={`group flex flex-col rounded-lg border px-3 py-3 transition-colors ${
        coordinator
          ? 'border-purple-400/30 bg-purple-500/10 hover:bg-purple-500/15'
          : 'border-white/10 bg-white/[0.07] hover:bg-white/[0.10]'
      } ${sessionId ? 'cursor-pointer' : ''}`}
    >
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium text-gray-100 truncate">{agent.displayName}</span>
            {coordinator && (
              <span class="flex-shrink-0 rounded bg-purple-500/15 px-1.5 py-0.5 text-xs font-medium text-purple-200">
                Coordinator
              </span>
            )}
          </div>
          <div class="mt-1 flex items-center gap-2 text-xs text-gray-400">
            <span
              class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColors[agent.status] ?? 'bg-gray-600'}`}
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
          {agent.instructions && (
            <p class="mt-1.5 text-xs text-gray-400 line-clamp-2 leading-relaxed">
              {agent.instructions}
            </p>
          )}
        </div>
        <div class="flex flex-shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-300"
            title="Edit"
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
              class="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-white/5 hover:text-red-400"
              title="Delete"
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
    </div>
  );
}

// ── Template card ─────────────────────────────────────────────────────────────

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
      class="text-left rounded-lg border border-blue-800/40 bg-blue-950/40 px-3 py-2.5 transition-colors hover:border-blue-700/60 hover:bg-blue-900/50"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-gray-200">{template.displayName}</span>
        {addedCount > 0 ? (
          <span class="flex-shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-400">
            ×{addedCount}
          </span>
        ) : (
          <svg
            class="w-3.5 h-3.5 flex-shrink-0 text-gray-400"
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
      <p class="mt-0.5 text-xs text-gray-400 line-clamp-2 leading-relaxed">
        {template.description}
      </p>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SpaceLongHorizonAgents({ spaceId }: { spaceId: string }) {
  const agents = spaceStore.longHorizonAgents.value;
  const templates = spaceStore.longHorizonAgentTemplates.value;
  const loading = !spaceStore.configDataLoaded.value;

  // Trigger lazy config load (agents + templates) if landing here on hard refresh
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

  useEffect(() => {
    if (agents.length === 0) return;
    const load = async () => {
      const counts: Record<string, number> = {};
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const reminders = await spaceStore.listLongHorizonAgentReminders(agent.id);
            counts[agent.id] = reminders.filter((r) => r.status === 'active').length;
          } catch {
            counts[agent.id] = 0;
          }
        })
      );
      setReminderCounts(counts);
    };
    load().catch(() => {});
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
  const existingHandles = new Set(agents.map((a) => a.handle));

  // Count how many active instances exist per template handle
  const templateHandleCounts = new Map<string, number>();
  for (const a of agents.filter((a) => a.status !== 'archived')) {
    templateHandleCounts.set(a.handle, (templateHandleCounts.get(a.handle) ?? 0) + 1);
  }

  if (loading) {
    return (
      <div class="flex-1 flex items-center justify-center">
        <span class="text-xs text-gray-400 animate-pulse">Loading agents…</span>
      </div>
    );
  }

  return (
    <div class="h-full overflow-y-auto scrollbar-dark">
      <div class="max-w-3xl mx-auto px-4 py-4 space-y-6">
        {/* Configured agents */}
        <section class="rounded-xl border border-white/8 bg-white/[0.03] p-4">
          <p class="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Configured · {sortedAgents.length}
          </p>
          {sortedAgents.length === 0 ? (
            <p class="text-xs text-gray-400 py-4">
              No agents yet — add one from the templates below.
            </p>
          ) : (
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {sortedAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  spaceId={spaceId}
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

        {/* Templates */}
        <section class="rounded-xl border border-blue-900/30 bg-blue-950/20 p-4">
          <div class="flex items-center justify-between mb-3">
            <p class="text-xs font-semibold uppercase tracking-wider text-blue-300/70">Templates</p>
            <button
              type="button"
              onClick={() => {
                setSelectedTemplate(null);
                setEditingAgent(null);
                setShowEditor(true);
              }}
              class="text-xs text-blue-300/70 hover:text-blue-200 transition-colors"
            >
              + Custom
            </button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {templates.map((t) => (
              <TemplateCard
                key={t.key}
                template={t}
                addedCount={templateHandleCounts.get(t.handle) ?? 0}
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
