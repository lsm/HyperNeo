import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { connectionManager } from '../../lib/connection-manager';
import { navigateToSpace } from '../../lib/router';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../../lib/runtime-capabilities';
import type { Space } from '@hyperneo/shared';

interface SpaceCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

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
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());

  const handlePathInput = (value: string) => {
    setWorkspacePath(value);
    if (!nameTouched) {
      const suggested = basenameFromPath(value);
      setName(suggested);
    }
  };

  const handleBrowse = async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setError('Not connected to server. Please wait...');
      return;
    }

    try {
      const picked = await hub.request<{ path: string | null }>('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      if (picked?.path) {
        handlePathInput(picked.path);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse for folder');
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    if (!workspacePath.trim()) {
      setError('Workspace path is required');
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

      const space = await hub.request<Space>('space.create', {
        workspacePath: workspacePath.trim(),
        name: name.trim() || basenameFromPath(workspacePath.trim()),
        description: description.trim() || undefined,
      });

      if (!space) {
        throw new Error('Server returned no data');
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
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Space" size="md">
      <form onSubmit={handleSubmit} class="space-y-5">
        {error && (
          <div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div>
          <label class="block text-sm font-medium text-gray-200 mb-1.5">
            Workspace Path
            <span class="text-red-400 ml-1">*</span>
          </label>
          <p class="text-xs text-gray-400 mb-2">
            Absolute path to the project directory this Space operates on.
          </p>
          <div class="flex gap-2">
            <input
              type="text"
              value={workspacePath}
              onInput={(e) => handlePathInput((e.target as HTMLInputElement).value)}
              placeholder="/Users/you/projects/my-app"
              class="flex-1 min-w-0 bg-dark-800 border border-dark-600 rounded-lg px-4 py-3 text-gray-100
								placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono text-sm"
              autoFocus
            />
            {nativeFolderPickerAvailable && (
              <button
                type="button"
                onClick={handleBrowse}
                title="Browse on this computer"
                class="px-4 py-3 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-gray-100 border border-dark-600 transition-colors shrink-0 text-sm font-medium"
              >
                Browse
              </button>
            )}
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
              setNameTouched(true);
            }}
            placeholder="e.g., My App"
            class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1.5">
            Description
            <span class="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <textarea
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            placeholder="Briefly describe the purpose of this space..."
            rows={3}
            class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
							placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none text-sm"
          />
        </div>

        <div class="flex gap-3 pt-1">
          <Button type="button" variant="secondary" onClick={handleClose} fullWidth>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} fullWidth>
            Create Space
          </Button>
        </div>
      </form>
    </Modal>
  );
}
