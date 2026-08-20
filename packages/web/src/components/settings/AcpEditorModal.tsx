import { useState } from 'preact/hooks';
import { updateProvider, fetchAcpModels } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { Button } from '../ui/Button.tsx';

export interface AcpConfiguredModel {
  id: string;
  name?: string;
}

interface AcpEditorModalProps {
  providerId: string;
  providerName: string;
  command: string;
  models: AcpConfiguredModel[];
  onClose: () => void;
  onSaved: () => void;
}

export function AcpEditorModal({
  providerId,
  providerName,
  command: initialCommand,
  models: initialModels,
  onClose,
  onSaved,
}: AcpEditorModalProps) {
  const [command, setCommand] = useState(initialCommand);
  const [models, setModels] = useState<AcpConfiguredModel[]>(initialModels);
  const [fetchedModels, setFetchedModels] = useState<AcpConfiguredModel[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandChanged = command.trim() !== initialCommand.trim();

  const existingModelIds = new Set(models.map((m) => m.id));
  const selectableFetched = fetchedModels?.filter((m) => !existingModelIds.has(m.id)) ?? [];

  const handleFetch = async () => {
    if (!command.trim()) {
      setError('ACP command is required');
      return;
    }
    setFetching(true);
    setError(null);
    setFetchedModels(null);
    setSelectedIds([]);
    try {
      const { models: fetched } = await fetchAcpModels(providerId, command.trim());
      setFetchedModels(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch models');
    } finally {
      setFetching(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addSelected = () => {
    const toAdd =
      fetchedModels?.filter((m) => selectedIds.includes(m.id) && !existingModelIds.has(m.id)) ?? [];
    if (toAdd.length === 0) return;
    setModels((prev) => [...prev, ...toAdd]);
    setSelectedIds([]);
  };

  const removeModel = (id: string) => {
    setModels((prev) => prev.filter((m) => m.id !== id));
  };

  const handleSave = async () => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setError('ACP command is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProvider(providerId, {
        configJson: JSON.stringify({
          command: trimmedCommand,
          models: commandChanged ? [] : models,
        }),
      });
      toast.success(`${providerName} updated`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
          <h3 class="text-sm font-semibold text-gray-100">Edit {providerName}</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            class="p-1 rounded hover:bg-dark-700"
          >
            <svg
              class="w-4 h-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <label class="block">
            <span class="text-xs font-medium text-gray-400 mb-1 block">ACP command</span>
            <input
              type="text"
              value={command}
              placeholder="e.g. devin acp"
              onInput={(e) => setCommand(e.currentTarget.value)}
              class="w-full bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 font-mono focus:outline-none focus:border-blue-500"
            />
            <span class="text-[11px] text-gray-500 mt-1 block">
              Shell command that launches the ACP agent.
            </span>
          </label>

          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-400">Models</h4>
              <Button
                size="xs"
                variant="secondary"
                onClick={handleFetch}
                loading={fetching}
                disabled={fetching}
              >
                Fetch models
              </Button>
            </div>

            {fetchedModels && (
              <div class="rounded-lg border border-white/[0.08] bg-dark-900/60 px-3 py-2.5 space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-gray-300">
                    {fetchedModels.length} model{fetchedModels.length === 1 ? '' : 's'} found
                  </span>
                  {selectableFetched.length > 0 && (
                    <Button
                      size="xs"
                      variant="primary"
                      onClick={addSelected}
                      disabled={selectedIds.length === 0}
                    >
                      Add selected
                    </Button>
                  )}
                </div>
                {selectableFetched.length === 0 ? (
                  <p class="text-xs text-gray-500 italic">All fetched models are already added.</p>
                ) : (
                  <div class="max-h-40 overflow-y-auto space-y-1">
                    {selectableFetched.map((m) => (
                      <label
                        key={m.id}
                        class="flex items-center gap-2 text-xs text-gray-200 cursor-pointer hover:bg-white/5 rounded px-1 py-0.5"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(m.id)}
                          onChange={() => toggleSelected(m.id)}
                          class="rounded border-dark-600 bg-dark-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
                        />
                        <span class="font-mono break-all">{m.id}</span>
                        {m.name && m.name !== m.id && <span class="text-gray-500">{m.name}</span>}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {models.length === 0 ? (
              <p class="text-xs text-gray-500 italic">
                No models selected — fetch and add models, or leave empty to use ACP Default.
              </p>
            ) : (
              <div class="space-y-1.5">
                {models.map((m) => (
                  <div
                    key={m.id}
                    class="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-dark-900/60 px-3 py-1.5"
                  >
                    <span class="flex-1 font-mono text-xs text-gray-200 break-all">{m.id}</span>
                    {m.name && m.name !== m.id && (
                      <span class="text-xs text-gray-500">{m.name}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeModel(m.id)}
                      aria-label={`Remove ${m.id}`}
                      class="p-1 rounded hover:bg-red-900/30 text-red-400"
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
                ))}
              </div>
            )}
          </div>
        </div>

        <div class="px-4 py-3 border-t border-dark-700 flex items-center gap-2">
          {error && <p class="mr-auto text-xs text-red-400">{error}</p>}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={saving}
          >
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
