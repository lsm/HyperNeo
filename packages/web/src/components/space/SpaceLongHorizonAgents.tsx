import type { SpaceLongHorizonAgent, SpaceLongHorizonAgentTemplate } from '@neokai/shared';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { pushOverlayHistory } from '../../lib/router';
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

// ── Template picker ──────────────────────────────────────────────────────────

interface TemplatePanelProps {
  templates: SpaceLongHorizonAgentTemplate[];
  existingHandles: Set<string>;
  onSelect: (template: SpaceLongHorizonAgentTemplate) => void;
  onCustom: () => void;
  onCancel: () => void;
}

function TemplatePanel({
  templates,
  existingHandles,
  onSelect,
  onCustom,
  onCancel,
}: TemplatePanelProps) {
  return (
    <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4">
      <div class="w-full max-w-lg rounded-xl border border-white/10 bg-dark-900 shadow-2xl">
        <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <p class="text-sm font-semibold text-gray-100">Add agent</p>
          <button
            type="button"
            onClick={onCancel}
            class="rounded p-1 text-gray-500 hover:text-gray-300 hover:bg-white/5"
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
        <div class="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {templates.map((t) => {
            const alreadyAdded = existingHandles.has(t.handle);
            return (
              <button
                key={t.key}
                type="button"
                disabled={alreadyAdded}
                onClick={() => onSelect(t)}
                class={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  alreadyAdded
                    ? 'border-white/5 bg-white/[0.02] opacity-40 cursor-not-allowed'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'
                }`}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-gray-100">{t.displayName}</span>
                  {alreadyAdded && <span class="text-xs text-gray-600">Added</span>}
                </div>
                <p class="mt-0.5 text-xs text-gray-500 line-clamp-2">{t.description}</p>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onCustom}
            class="w-full text-left rounded-lg border border-dashed border-white/10 px-3 py-2.5 hover:border-white/20 hover:bg-white/[0.03] transition-colors"
          >
            <span class="text-sm font-medium text-gray-300">Custom agent</span>
            <p class="mt-0.5 text-xs text-gray-500">Start from scratch with a blank agent.</p>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Agent editor ─────────────────────────────────────────────────────────────

interface AgentEditorProps {
  template?: SpaceLongHorizonAgentTemplate | null;
  agent?: SpaceLongHorizonAgent | null;
  onSave: () => void;
  onCancel: () => void;
}

function AgentEditor({ template, agent, onSave, onCancel }: AgentEditorProps) {
  const isEdit = !!agent;
  const [displayName, setDisplayName] = useState(agent?.displayName ?? template?.displayName ?? '');
  const [handle, setHandle] = useState(agent?.handle ?? template?.handle ?? '');
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
            class="rounded p-1 text-gray-500 hover:text-gray-300 hover:bg-white/5"
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
                      : 'bg-white/5 text-gray-500 hover:bg-white/10 hover:text-gray-300'
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
            {autonomyLevel && (
              <p class="mt-1 text-xs text-gray-600">{AUTONOMY_LABELS[autonomyLevel]}</p>
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
  reminderCount: number;
  onEdit: () => void;
  onDelete: () => void;
  onChat: () => void;
}

function AgentCard({ agent, reminderCount, onEdit, onDelete, onChat }: AgentCardProps) {
  const coordinator = isCoordinator(agent);
  const statusColors: Record<string, string> = {
    active: 'bg-green-500',
    paused: 'bg-amber-500',
    disabled: 'bg-gray-600',
    archived: 'bg-gray-700',
  };

  return (
    <div
      class={`group rounded-lg border px-3 py-3 ${
        coordinator
          ? 'border-purple-400/30 bg-purple-500/[0.06]'
          : 'border-white/10 bg-white/[0.025]'
      }`}
    >
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium text-gray-100">{agent.displayName}</span>
            {coordinator && (
              <span class="rounded bg-purple-500/15 px-1.5 py-0.5 text-xs font-medium text-purple-200">
                Coordinator
              </span>
            )}
            <span class="flex items-center gap-1 text-xs text-gray-600">
              <span
                class={`w-1.5 h-1.5 rounded-full ${statusColors[agent.status] ?? 'bg-gray-600'}`}
              />
              {agent.status}
            </span>
            {agent.autonomyLevel && (
              <span class="rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-500">
                L{agent.autonomyLevel} · {AUTONOMY_LABELS[agent.autonomyLevel]}
              </span>
            )}
          </div>
          {agent.instructions && (
            <p class="mt-1 text-xs text-gray-500 line-clamp-2 leading-relaxed">
              {agent.instructions}
            </p>
          )}
          <div class="mt-2 flex items-center gap-3 text-xs text-gray-600">
            <span>
              {reminderCount} reminder{reminderCount !== 1 ? 's' : ''}
            </span>
            {agent.handle && <span class="font-mono">@{agent.handle}</span>}
          </div>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={onChat}
            class="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/10 hover:text-blue-200"
            title="Open chat"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            Chat
          </button>
          <button
            type="button"
            onClick={onEdit}
            class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-300"
            title="Edit agent"
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
          {!coordinator && (
            <button
              type="button"
              onClick={onDelete}
              class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-red-400"
              title="Delete agent"
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
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SpaceLongHorizonAgents({ spaceId }: { spaceId: string }) {
  const agents = spaceStore.longHorizonAgents.value;
  const templates = spaceStore.longHorizonAgentTemplates.value;
  const loading = spaceStore.loading.value;

  const [reminderCounts, setReminderCounts] = useState<Record<string, number>>({});
  const [showTemplates, setShowTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<SpaceLongHorizonAgentTemplate | null>(
    null
  );
  const [editingAgent, setEditingAgent] = useState<SpaceLongHorizonAgent | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState<SpaceLongHorizonAgent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Load reminder counts for all agents
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

  const handleChat = useCallback(
    (agent: SpaceLongHorizonAgent) => {
      const sessionId = agent.sessionId ?? `space:chat:${spaceId}`;
      pushOverlayHistory(sessionId, agent.displayName);
    },
    [spaceId]
  );

  const handleTemplateSelect = (template: SpaceLongHorizonAgentTemplate) => {
    setSelectedTemplate(template);
    setShowTemplates(false);
    setShowEditor(true);
  };

  const handleCustom = () => {
    setSelectedTemplate(null);
    setShowTemplates(false);
    setShowEditor(true);
  };

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

  const handleEdit = (agent: SpaceLongHorizonAgent) => {
    setEditingAgent(agent);
    setShowEditor(true);
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

  if (loading) {
    return (
      <div class="flex-1 flex items-center justify-center">
        <span class="text-xs text-gray-600 animate-pulse">Loading agents…</span>
      </div>
    );
  }

  return (
    <div class="flex flex-col h-full min-h-0 px-4 py-4 gap-4 overflow-y-auto scrollbar-dark">
      {/* Header row */}
      <div class="flex items-center justify-between gap-3 flex-shrink-0">
        <div>
          <p class="text-xs font-semibold uppercase tracking-wider text-gray-400">
            {agents.length} agent{agents.length !== 1 ? 's' : ''} configured
          </p>
          <p class="mt-0.5 text-xs text-gray-600">
            Long-horizon agents run continuously, managing goals, reminders, and events across this
            space.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowTemplates(true)}>
          <svg class="w-3.5 h-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
          Add agent
        </Button>
      </div>

      {/* Agent list */}
      {sortedAgents.length === 0 ? (
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <p class="text-sm font-medium text-gray-400">No agents yet</p>
          <p class="mt-1 text-xs text-gray-600">Add a template or create a custom agent.</p>
          <div class="mt-4">
            <Button size="sm" variant="secondary" onClick={() => setShowTemplates(true)}>
              Add agent
            </Button>
          </div>
        </div>
      ) : (
        <div class="space-y-2">
          {sortedAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              reminderCount={reminderCounts[agent.id] ?? 0}
              onChat={() => handleChat(agent)}
              onEdit={() => handleEdit(agent)}
              onDelete={() => {
                setDeletingAgent(agent);
                setDeleteError(null);
              }}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {showTemplates && (
        <TemplatePanel
          templates={templates}
          existingHandles={existingHandles}
          onSelect={handleTemplateSelect}
          onCustom={handleCustom}
          onCancel={() => setShowTemplates(false)}
        />
      )}

      {showEditor && (
        <AgentEditor
          template={selectedTemplate}
          agent={editingAgent}
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
