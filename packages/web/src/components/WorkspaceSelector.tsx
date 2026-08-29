import { useState, useEffect } from 'preact/hooks';
import type { WorkspaceHistoryEntry } from '@hyperneo/shared';
import { connectionManager } from '../lib/connection-manager';
import {
  getWorkspaceHistory,
  addWorkspaceToHistory,
  setSessionWorkspace,
} from '../lib/api-helpers';
import { addRecentPath } from '../lib/recent-paths';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../lib/runtime-capabilities';

interface WorkspaceSelectorProps {
  sessionId: string;
  onConfirm: () => void;
  onSkip: () => void;
}

export function WorkspaceSelector({
  sessionId,
  onConfirm: onConfirmCallback,
  onSkip,
}: WorkspaceSelectorProps) {
  const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [customPath, setCustomPath] = useState<string>('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [worktreeMode, setWorktreeMode] = useState<'worktree' | 'direct'>('worktree');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());

  useEffect(() => {
    getWorkspaceHistory()
      .then((entries) => {
        setHistory(entries);
        if (entries.length > 0) {
          setSelectedPath(entries[0].path);
        }
      })
      .catch(() => {});
  }, []);

  const activePath = showCustomInput ? customPath.trim() : selectedPath;

  const handleBrowse = async () => {
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        setShowCustomInput(true);
        setError('Not connected to server. Please wait...');
        return;
      }
      const response = await hub.request<{ path: string | null }>('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      const pickedPath = response.path;
      if (pickedPath) {
        setHistory((entries) =>
          entries.some((entry) => entry.path === pickedPath)
            ? entries
            : [{ path: pickedPath, lastUsedAt: Date.now(), useCount: 0 }, ...entries]
        );
        setSelectedPath(pickedPath);
        setCustomPath('');
        setShowCustomInput(false);
        setError(null);
      } else {
        setShowCustomInput(true);
        setError('Enter a path manually if the folder picker is unavailable.');
      }
    } catch {
      setShowCustomInput(true);
      setError('Enter a path manually if the folder picker is unavailable.');
    }
  };

  const handleSelectChange = (value: string) => {
    if (value === '__manual__') {
      setShowCustomInput(true);
      setSelectedPath('');
    } else if (value === '__none__') {
    } else {
      setSelectedPath(value);
      setShowCustomInput(false);
    }
  };

  const handleConfirm = async () => {
    const path = activePath;
    if (!path) {
      setError('Please select or enter a workspace path');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const entry = await addWorkspaceToHistory(path);
      await setSessionWorkspace(sessionId, entry.path, worktreeMode);

      addRecentPath(entry.path);

      onConfirmCallback();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set workspace');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 py-12">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <div class="flex items-center justify-center mb-5">
            <div class="w-16 h-16 rounded-2xl bg-surface-raised border border-line flex items-center justify-center shadow-lg">
              <svg
                class="w-8 h-8 text-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={1.5}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
            </div>
          </div>
          <h2 class="text-xl font-semibold text-fg mb-2">Select a workspace</h2>
          <p class="text-sm text-fg-faint max-w-xs mx-auto">
            Choose a project folder to give Claude context for your work, or skip to chat without
            one.
          </p>
        </div>

        <div class="bg-surface-raised border border-line rounded-2xl p-5 space-y-4 shadow-xl">
          {!showCustomInput ? (
            <div>
              <label class="block text-xs font-medium text-fg-muted mb-1.5">Workspace folder</label>
              <div class="flex gap-2">
                <select
                  value={selectedPath || '__none__'}
                  onChange={(e) => handleSelectChange((e.target as HTMLSelectElement).value)}
                  class="flex-1 bg-surface border border-line-strong rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent cursor-pointer"
                >
                  {history.length === 0 ? (
                    <option value="__none__" disabled>
                      No recent workspaces
                    </option>
                  ) : (
                    history.map((item) => (
                      <option key={item.path} value={item.path}>
                        {item.path}
                      </option>
                    ))
                  )}
                  <option value="__manual__">Enter project path...</option>
                </select>
                {nativeFolderPickerAvailable && (
                  <button
                    type="button"
                    onClick={handleBrowse}
                    title="Browse on this computer"
                    class="p-2 rounded-lg bg-fill-strong hover:bg-line-strong text-fg-muted hover:text-fg border border-line-strong transition-colors shrink-0"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div>
              <label class="block text-xs font-medium text-fg-muted mb-1.5">Workspace folder</label>
              <div class="flex gap-2">
                <input
                  type="text"
                  value={customPath}
                  onInput={(e) => setCustomPath((e.target as HTMLInputElement).value)}
                  placeholder="Project path"
                  autoFocus
                  class="flex-1 bg-surface border border-line-strong rounded-lg px-3 py-2 text-sm text-fg placeholder-gray-500 focus:outline-none focus:border-accent"
                />
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustomInput(false);
                      setSelectedPath(history[0].path);
                    }}
                    title="Back to recent workspaces"
                    class="p-2 rounded-lg bg-fill-strong hover:bg-line-strong text-fg-muted hover:text-fg border border-line-strong transition-colors shrink-0"
                  >
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                )}
              </div>
              <p class="mt-1.5 text-[11px] leading-4 text-fg-faint">
                Use an absolute path accessible to HyperNeo.
              </p>
            </div>
          )}

          {activePath && (
            <div>
              <label class="block text-xs font-medium text-fg-muted mb-1.5">Edit mode</label>
              <div class="flex rounded-lg overflow-hidden border border-line-strong">
                <button
                  type="button"
                  onClick={() => setWorktreeMode('worktree')}
                  class={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                    worktreeMode === 'worktree'
                      ? 'bg-success/40 text-success-soft'
                      : 'bg-surface text-fg-muted hover:text-fg-soft'
                  }`}
                >
                  Worktree
                  <span
                    class={`block text-[10px] font-normal mt-0.5 ${
                      worktreeMode === 'worktree' ? 'text-success/70' : 'text-fg-faint'
                    }`}
                  >
                    Isolated branch (safe)
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setWorktreeMode('direct')}
                  class={`flex-1 px-3 py-2 text-xs font-medium transition-colors border-l border-line-strong ${
                    worktreeMode === 'direct'
                      ? 'bg-warning/30 text-warning'
                      : 'bg-surface text-fg-muted hover:text-fg-soft'
                  }`}
                >
                  Direct
                  <span
                    class={`block text-[10px] font-normal mt-0.5 ${
                      worktreeMode === 'direct' ? 'text-warning/70' : 'text-fg-faint'
                    }`}
                  >
                    Edit directly (fast)
                  </span>
                </button>
              </div>
            </div>
          )}

          {error && <p class="text-xs text-danger">{error}</p>}

          <div class="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onSkip}
              class="flex-1 px-4 py-2.5 text-sm text-fg-muted hover:text-fg-soft bg-fill-strong hover:bg-line-strong border border-line-strong rounded-xl transition-colors font-medium"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!activePath || loading}
              class="flex-1 px-4 py-2.5 bg-accent-hover hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed text-accent-fg text-sm font-medium rounded-xl transition-colors"
            >
              {loading ? 'Setting...' : 'Start with workspace'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
