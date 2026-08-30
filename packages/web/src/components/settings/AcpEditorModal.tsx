import { getAcpCommandIdentity } from '@hyperneo/shared/acp';
import { useRef, useState } from 'preact/hooks';
import { updateProvider, fetchAcpModels } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { Button } from '../ui/Button.tsx';
import { Modal } from '../ui/Modal.tsx';

export interface AcpConfiguredModel {
  id: string;
  name?: string;
}

interface AcpEditorModalProps {
  providerId: string;
  providerName: string;
  command: string;
  models?: AcpConfiguredModel[];
  envBacked?: boolean;
  configJson?: string;
  onClose: () => void;
  onSaved: () => void;
}

function acpCommandsEquivalent(left: string, right: string): boolean {
  try {
    return getAcpCommandIdentity(left) === getAcpCommandIdentity(right);
  } catch {
    return left.trim() === right.trim();
  }
}

function readSiblingConfig(configJson: string | undefined): Record<string, unknown> {
  if (!configJson) return {};
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const siblings = { ...(parsed as Record<string, unknown>) };
    delete siblings.command;
    delete siblings.models;
    return siblings;
  } catch {
    return {};
  }
}

export function AcpEditorModal({
  providerId,
  providerName,
  command: initialCommand,
  models: initialModels,
  envBacked = false,
  configJson,
  onClose,
  onSaved,
}: AcpEditorModalProps) {
  const [command, setCommand] = useState(initialCommand);
  const [models, setModels] = useState<AcpConfiguredModel[] | undefined>(initialModels);
  const [modelsCommand, setModelsCommand] = useState(initialCommand.trim());
  const [fetchedModels, setFetchedModels] = useState<AcpConfiguredModel[] | null>(null);
  const [fetchedCommand, setFetchedCommand] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeFetchRef = useRef(0);
  const commandChanged = !acpCommandsEquivalent(command, initialCommand);
  const currentCommand = command.trim();
  const persistedModels = !commandChanged
    ? acpCommandsEquivalent(modelsCommand, initialCommand)
      ? models
      : initialModels
    : acpCommandsEquivalent(modelsCommand, currentCommand) &&
        fetchedCommand !== null &&
        acpCommandsEquivalent(fetchedCommand, currentCommand)
      ? models
      : [];
  const persistEmptySelection =
    persistedModels !== undefined && persistedModels.length === 0 && !commandChanged;

  const existingModelIds = new Set((persistedModels ?? []).map((m) => m.id));
  const selectableFetched = fetchedModels?.filter((m) => !existingModelIds.has(m.id)) ?? [];

  const handleFetch = async () => {
    const reqId = ++activeFetchRef.current;
    const trimmedCommand = command.trim();
    setFetching(true);
    setError(null);
    setFetchedModels(null);
    setFetchedCommand(null);
    setSelectedIds([]);
    try {
      const { models: fetched } = await fetchAcpModels(providerId, trimmedCommand || '');
      if (reqId !== activeFetchRef.current) return;
      if (!acpCommandsEquivalent(trimmedCommand, modelsCommand)) {
        setModels([]);
        setModelsCommand(trimmedCommand);
      }
      setFetchedModels(fetched);
      setFetchedCommand(trimmedCommand);
    } catch (err) {
      if (reqId !== activeFetchRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch models');
    } finally {
      if (reqId === activeFetchRef.current) {
        setFetching(false);
      }
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addSelected = () => {
    const toAdd =
      fetchedModels?.filter((m) => selectedIds.includes(m.id) && !existingModelIds.has(m.id)) ?? [];
    if (toAdd.length === 0) return;
    setModels((prev) => [...(prev ?? []), ...toAdd]);
    setSelectedIds([]);
  };

  const removeModel = (id: string) => {
    setModels((prev) => prev?.filter((m) => m.id !== id));
  };

  const handleSave = async () => {
    const trimmedCommand = command.trim();
    setSaving(true);
    setError(null);
    try {
      await updateProvider(providerId, {
        configJson: JSON.stringify({
          ...readSiblingConfig(configJson),
          ...(trimmedCommand ? { command: trimmedCommand } : {}),
          ...(persistedModels?.length || persistEmptySelection ? { models: persistedModels } : {}),
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
    <Modal isOpen onClose={onClose} title={`Edit ${providerName}`} size="lg">
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs font-medium text-fg-muted mb-1 block">ACP command</span>
          <input
            type="text"
            value={command}
            placeholder="e.g. devin acp"
            onInput={(e) => {
              activeFetchRef.current++;
              setFetching(false);
              setCommand(e.currentTarget.value);
            }}
            class="w-full bg-bg border border-line rounded px-2 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent"
          />
          <span class="text-[11px] text-fg-faint mt-1 block">
            Shell command that launches the ACP agent.
            {envBacked
              ? ' Leave empty to keep using HYPERNEO_ACP_COMMAND.'
              : ' Leave empty to fall back to HYPERNEO_ACP_COMMAND.'}
          </span>
        </label>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h4 class="text-xs font-semibold uppercase tracking-wider text-fg-muted">Models</h4>
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
            <div class="rounded-lg border border-line bg-surface/60 px-3 py-2.5 space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-xs text-fg-soft">
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
              {fetchedModels.length === 0 ? (
                <p class="text-xs text-fg-faint italic">The ACP agent reported no models.</p>
              ) : selectableFetched.length === 0 ? (
                <p class="text-xs text-fg-faint italic">All fetched models are already added.</p>
              ) : (
                <div class="max-h-40 overflow-y-auto space-y-1">
                  {selectableFetched.map((m) => (
                    <label
                      key={m.id}
                      class="flex items-center gap-2 text-xs text-fg-soft cursor-pointer hover:bg-fill-soft rounded px-1 py-0.5"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(m.id)}
                        onChange={() => toggleSelected(m.id)}
                        class="rounded border-line-strong bg-surface text-accent focus:ring-accent focus:ring-offset-0"
                      />
                      <span class="font-mono break-all">{m.id}</span>
                      {m.name && m.name !== m.id && <span class="text-fg-faint">{m.name}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {!persistedModels?.length ? (
            <p class="text-xs text-fg-faint italic">
              {persistEmptySelection
                ? 'No models selected — saving will hide all models for this command.'
                : 'No models selected — fetch and add models, or leave empty to use ACP Default.'}
            </p>
          ) : (
            <div class="space-y-1.5">
              {persistedModels.map((m) => (
                <div
                  key={m.id}
                  class="flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-3 py-1.5"
                >
                  <span class="flex-1 font-mono text-xs text-fg-soft break-all">{m.id}</span>
                  {m.name && m.name !== m.id && <span class="text-xs text-fg-faint">{m.name}</span>}
                  <button
                    type="button"
                    onClick={() => removeModel(m.id)}
                    aria-label={`Remove ${m.id}`}
                    class="p-1 rounded hover:bg-danger/30 text-danger"
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

        <div class="flex items-center gap-2 pt-4 border-t border-line">
          {error && <p class="mr-auto text-xs text-danger">{error}</p>}
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
    </Modal>
  );
}
