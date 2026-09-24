import { DEFAULT_SEED_AGENT_TEMPLATE_KEY, type SpaceCreateResult } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager';
import { navigateToSpace } from '../../lib/router';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../../lib/runtime-capabilities';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import {
  FORM_CHECKBOX_CLASS,
  FORM_CONTROL_CLASS,
  FORM_LABEL_CLASS,
  FormActions,
} from '../ui/FormField';
import { Modal } from '../ui/Modal';

interface SpaceCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ExtraWorkspaceRow {
  id: number;
  path: string;
  label: string;
}

const MAX_ADDITIONAL_WORKSPACES = 127;
const SPACE_CREATE_TIMEOUT_MS = 10000;
const PER_WORKSPACE_TIMEOUT_MS = 1000;

let extraWorkspaceRowSeq = 0;

function basenameFromPath(p: string): string {
  const normalized = p.replace(/[/\\]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

export function SpaceCreateDialog({ isOpen, onClose }: SpaceCreateDialogProps) {
  const [workspacePath, setWorkspacePath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraWorkspaces, setExtraWorkspaces] = useState<ExtraWorkspaceRow[]>([]);
  const [seedAgent, setSeedAgent] = useState(true);
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());

  const handlePathInput = (value: string) => {
    setWorkspacePath(value);
    if (!nameTouched) {
      const suggested = basenameFromPath(value);
      setName(suggested);
    }
  };

  const pickFolder = async (): Promise<string | null> => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setError('Not connected to server. Please wait...');
      return null;
    }

    try {
      const picked = await hub.request<{ path: string | null }>('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      if (picked?.path) {
        setError(null);
        return picked.path;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse for folder');
    }
    return null;
  };

  const handleBrowse = async () => {
    const path = await pickFolder();
    if (path !== null) handlePathInput(path);
  };

  const updateExtraWorkspace = (id: number, patch: Partial<ExtraWorkspaceRow>) => {
    setExtraWorkspaces((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const handleExtraBrowse = async (id: number) => {
    const path = await pickFolder();
    if (path !== null) updateExtraWorkspace(id, { path });
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    if (!workspacePath.trim()) {
      setError('Workspace path is required');
      return;
    }

    const partialIndex = extraWorkspaces.findIndex(
      (row) => row.path.trim() === '' && row.label.trim() !== ''
    );
    if (partialIndex !== -1) {
      setError(`Additional workspace ${partialIndex + 1}: path is required`);
      return;
    }

    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setError('Not connected to server');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const additionalWorkspaces = extraWorkspaces
        .filter((row) => row.path.trim() !== '')
        .map((row) => ({
          path: row.path.trim(),
          ...(row.label.trim() ? { label: row.label.trim() } : {}),
        }));

      const createTimeoutMs =
        SPACE_CREATE_TIMEOUT_MS + additionalWorkspaces.length * PER_WORKSPACE_TIMEOUT_MS;

      const space = await hub.request<SpaceCreateResult>(
        'space.create',
        {
          workspacePath: workspacePath.trim(),
          name: name.trim() || basenameFromPath(workspacePath.trim()),
          description: description.trim() || undefined,
          ...(additionalWorkspaces.length > 0 ? { additionalWorkspaces } : {}),
          ...(seedAgent ? { seedAgentTemplateKeys: [DEFAULT_SEED_AGENT_TEMPLATE_KEY] } : {}),
        },
        { timeout: createTimeoutMs }
      );

      if (!space) {
        throw new Error('Server returned no data');
      }

      if (space.seedWarnings && space.seedWarnings.length > 0) {
        toast.warning(space.seedWarnings.join(' · '));
      }

      navigateToSpace(space.slug);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create space');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setWorkspacePath('');
    setName('');
    setDescription('');
    setNameTouched(false);
    setError(null);
    setExtraWorkspaces([]);
    setSeedAgent(true);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create Space"
      size="md"
      footer={
        <FormActions
          error={error}
          onCancel={handleClose}
          submitLabel="Create Space"
          submitting={submitting}
          formId="space-create-form"
        />
      }
    >
      <form id="space-create-form" onSubmit={handleSubmit} class="space-y-4">
        <div>
          <span class={FORM_LABEL_CLASS}>
            Workspace Path
            <span class="ml-1 text-danger">*</span>
          </span>
          <p class="mb-2 text-xs text-fg-faint">
            Absolute path to the project directory this Space operates on.
          </p>
          <div class="flex gap-2">
            <input
              type="text"
              value={workspacePath}
              onInput={(e) => handlePathInput((e.target as HTMLInputElement).value)}
              placeholder="/Users/you/projects/my-app"
              class={cn(FORM_CONTROL_CLASS, 'min-w-0 flex-1 font-mono')}
              autoFocus
            />
            {nativeFolderPickerAvailable && (
              <button
                type="button"
                onClick={handleBrowse}
                title="Browse on this computer"
                class="shrink-0 rounded border border-line px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
              >
                Browse
              </button>
            )}
          </div>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between">
            <span class={cn(FORM_LABEL_CLASS, 'mb-0')}>
              Additional Workspaces
              <span class="ml-2 text-xs text-fg-faint">(optional)</span>
            </span>
            <button
              type="button"
              disabled={extraWorkspaces.length >= MAX_ADDITIONAL_WORKSPACES}
              onClick={() =>
                setExtraWorkspaces((prev) => [
                  ...prev,
                  { id: ++extraWorkspaceRowSeq, path: '', label: '' },
                ])
              }
              class="text-xs text-accent hover:text-accent-soft transition-colors disabled:text-fg-faint disabled:hover:text-fg-faint"
            >
              + Add workspace
            </button>
          </div>
          <p class="mb-2 text-xs text-fg-faint">
            Extra project directories this Space can access. An invalid path rejects the whole
            create.
          </p>
          {extraWorkspaces.length > 0 && (
            <div class="space-y-2">
              {extraWorkspaces.map((row, index) => (
                <div key={row.id} class="space-y-2 rounded-lg border border-line bg-surface/60 p-3">
                  <div class="flex gap-2">
                    <input
                      type="text"
                      value={row.path}
                      onInput={(e) =>
                        updateExtraWorkspace(row.id, {
                          path: (e.target as HTMLInputElement).value,
                        })
                      }
                      placeholder="/Users/you/projects/other-repo"
                      class={cn(FORM_CONTROL_CLASS, 'min-w-0 flex-1 font-mono')}
                    />
                    {nativeFolderPickerAvailable && (
                      <button
                        type="button"
                        onClick={() => handleExtraBrowse(row.id)}
                        title="Browse on this computer"
                        class="shrink-0 rounded border border-line px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
                      >
                        Browse
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setExtraWorkspaces((prev) => prev.filter((entry) => entry.id !== row.id))
                      }
                      aria-label={`Remove additional workspace ${index + 1}`}
                      class="shrink-0 px-1 text-fg-muted transition-colors hover:text-danger"
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
                  <input
                    type="text"
                    value={row.label}
                    onInput={(e) =>
                      updateExtraWorkspace(row.id, {
                        label: (e.target as HTMLInputElement).value,
                      })
                    }
                    placeholder="Label (optional)"
                    class={FORM_CONTROL_CLASS}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <span class={FORM_LABEL_CLASS}>Name</span>
          <input
            type="text"
            value={name}
            onFocus={(e) => {
              if (!nameTouched && name) (e.target as HTMLInputElement).select();
            }}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
              setNameTouched(true);
            }}
            placeholder="e.g., My App"
            class={FORM_CONTROL_CLASS}
          />
        </div>

        <div>
          <span class={FORM_LABEL_CLASS}>
            Description
            <span class="ml-2 text-xs text-fg-faint">(optional)</span>
          </span>
          <textarea
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            placeholder="Briefly describe the purpose of this space..."
            rows={3}
            class={cn(FORM_CONTROL_CLASS, 'resize-none')}
          />
        </div>

        <div>
          <label class="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={seedAgent}
              onChange={(e) => setSeedAgent((e.target as HTMLInputElement).checked)}
              class={cn(FORM_CHECKBOX_CLASS, 'mt-0.5')}
            />
            <span>
              <span class="block text-sm font-medium text-fg-soft">Start with an agent</span>
              <span class="mt-0.5 block text-xs text-fg-muted">
                Adds a Task Manager agent that can approve work and own goals. Uncheck to create an
                empty Space you staff yourself.
              </span>
            </span>
          </label>
        </div>
      </form>
    </Modal>
  );
}
