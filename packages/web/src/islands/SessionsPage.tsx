import { useEffect, useMemo, useState } from 'preact/hooks';
import type {
  CreateSessionRequest,
  GitBranchesResponse,
  ModelInfo,
  Provider,
  WorkspaceHistoryEntry,
} from '@hyperneo/shared';
import { connectionState, globalSettings, sessions } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import {
  createSession,
  getWorkspaceHistory,
  getGitBranches,
  addWorkspaceToHistory,
} from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import { isUserSession } from '../lib/session-utils.ts';
import { listProjectPaths } from '../lib/projects.ts';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../lib/runtime-capabilities.ts';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { WorkspaceChips } from '../components/WorkspaceChips.tsx';
import { NewChatModelPicker } from '../components/NewChatModelPicker.tsx';
import { useModelSwitcher } from '../hooks/useModelSwitcher.ts';

type NewChatWorktreeMode = 'worktree' | 'direct';

interface NewChatModelSelection {
  id: string;
  provider: string;
}

interface NewChatSelection {
  project: string | null;
  mode: NewChatWorktreeMode;
  baseBranch: string | null;
  model: NewChatModelSelection | null;
}

const NEW_CHAT_SELECTION_KEY = 'hyperneo_new_chat_selection';
const DEFAULT_NEW_CHAT_SELECTION: NewChatSelection = {
  project: null,
  mode: 'worktree',
  baseBranch: null,
  model: null,
};

function loadNewChatSelection(): NewChatSelection {
  try {
    const stored = localStorage.getItem(NEW_CHAT_SELECTION_KEY);
    if (!stored) return DEFAULT_NEW_CHAT_SELECTION;
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_NEW_CHAT_SELECTION;
    const value = parsed as Partial<NewChatSelection>;
    const mode = value.mode === 'direct' ? 'direct' : 'worktree';
    return {
      project: typeof value.project === 'string' ? value.project : null,
      mode,
      baseBranch: typeof value.baseBranch === 'string' ? value.baseBranch : null,
      model:
        value.model &&
        typeof value.model === 'object' &&
        'id' in value.model &&
        'provider' in value.model &&
        typeof value.model.id === 'string' &&
        typeof value.model.provider === 'string'
          ? { id: value.model.id, provider: value.model.provider }
          : null,
    };
  } catch {
    return DEFAULT_NEW_CHAT_SELECTION;
  }
}

function saveNewChatSelection(selection: NewChatSelection): void {
  try {
    localStorage.setItem(NEW_CHAT_SELECTION_KEY, JSON.stringify(selection));
  } catch {}
}

function getKnownBranches(info: GitBranchesResponse): Set<string> {
  return new Set(
    [info.defaultBranch, info.currentBranch, ...info.branches].filter(
      (branch): branch is string => typeof branch === 'string' && branch.length > 0
    )
  );
}

function findModelInfo(
  models: ModelInfo[],
  selection: NewChatModelSelection | null
): ModelInfo | null {
  if (!selection) return null;
  return (
    models.find((model) => model.id === selection.id && model.provider === selection.provider) ??
    models.find((model) => model.id === selection.id) ??
    null
  );
}

function findDefaultModelInfo(models: ModelInfo[], modelId: string | undefined): ModelInfo | null {
  if (!modelId) return null;
  return (
    models.find((model) => model.id === modelId || model.alias === modelId) ??
    models.find((model) => model.id.includes(modelId) || model.alias?.includes(modelId)) ??
    null
  );
}

function getModelLabel(modelInfo: ModelInfo | null, fallbackModelId: string | undefined): string {
  if (modelInfo) return modelInfo.name;
  if (fallbackModelId) return fallbackModelId.replace(/-/g, ' ');
  return 'Model';
}

export function SessionsPage() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [initialSelection] = useState<NewChatSelection>(() => loadNewChatSelection());
  const { availableModels, loading: modelLoading } = useModelSwitcher(null);

  const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
  const [project, setProject] = useState<string | null>(initialSelection.project);
  const [gitInfo, setGitInfo] = useState<GitBranchesResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [mode, setMode] = useState<NewChatWorktreeMode>(initialSelection.mode);
  const [baseBranch, setBaseBranch] = useState<string | null>(initialSelection.baseBranch);
  const [manualProjectOpen, setManualProjectOpen] = useState(false);
  const [manualProjectPath, setManualProjectPath] = useState('');
  const [manualProjectError, setManualProjectError] = useState<string | null>(null);
  const [manualProjectBusy, setManualProjectBusy] = useState(false);
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());
  const [selectedModel, setSelectedModel] = useState<NewChatModelSelection | null>(
    initialSelection.model
  );

  const canCreate = connectionState.value === 'connected';
  const waitingForProjectGit = project !== null && gitLoading;

  const projectPaths = listProjectPaths(sessions.value.filter(isUserSession), history);
  const defaultModelId = globalSettings.value?.model ?? 'sonnet';
  const selectedModelInfo = useMemo(
    () => findModelInfo(availableModels, selectedModel),
    [availableModels, selectedModel]
  );
  const defaultModelInfo = useMemo(
    () => findDefaultModelInfo(availableModels, defaultModelId),
    [availableModels, defaultModelId]
  );
  const activeModelInfo = selectedModelInfo ?? defaultModelInfo;
  const activeModelLabel = getModelLabel(
    activeModelInfo,
    selectedModel ? selectedModel.id : defaultModelId
  );

  useEffect(() => {
    if (!selectedModel || !selectedModelInfo) return;
    if (
      selectedModel.id === selectedModelInfo.id &&
      selectedModel.provider === selectedModelInfo.provider
    ) {
      return;
    }
    setSelectedModel({ id: selectedModelInfo.id, provider: selectedModelInfo.provider });
  }, [selectedModel, selectedModelInfo]);

  useEffect(() => {
    getWorkspaceHistory()
      .then(setHistory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    saveNewChatSelection({ project, mode, baseBranch, model: selectedModel });
  }, [project, mode, baseBranch, selectedModel]);

  useEffect(() => {
    if (!project) {
      setGitInfo(null);
      setGitLoading(false);
      setBaseBranch(null);
      return;
    }
    let cancelled = false;
    setGitLoading(true);
    setGitInfo(null);
    getGitBranches(project)
      .then((info) => {
        if (cancelled) return;
        setGitInfo(info);
        if (info.isGitRepo) {
          const canWorktree = info.branches.length > 0;
          const knownBranches = getKnownBranches(info);
          setMode((currentMode) => (canWorktree ? currentMode : 'direct'));
          setBaseBranch((currentBranch) =>
            currentBranch && knownBranches.has(currentBranch)
              ? currentBranch
              : (info.defaultBranch ?? info.currentBranch ?? null)
          );
        } else {
          setBaseBranch(null);
        }
        setGitLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setGitInfo(null);
        setGitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const handleSelectProject = (path: string | null) => {
    setProject(path);
    if (!path) setBaseBranch(null);
  };

  const addProjectFromPath = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      setManualProjectError('Enter an absolute project path.');
      return;
    }
    setManualProjectBusy(true);
    setManualProjectError(null);
    try {
      const entry = await addWorkspaceToHistory(trimmed);
      setHistory((prev) => [entry, ...prev.filter((p) => p.path !== entry.path)]);
      handleSelectProject(entry.path);
      setManualProjectPath('');
      setManualProjectOpen(false);
    } catch (err) {
      setManualProjectOpen(true);
      setManualProjectError(err instanceof Error ? err.message : 'Failed to add project');
    } finally {
      setManualProjectBusy(false);
    }
  };

  const openManualProjectFallback = (message?: string) => {
    setManualProjectOpen(true);
    setManualProjectError(message ?? null);
  };

  const handleBrowse = async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      openManualProjectFallback('Not connected to server. Please wait...');
      return;
    }
    try {
      const picked = await hub.request<{ path: string | null }>('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      if (!picked?.path) {
        openManualProjectFallback('Enter a path manually if the folder picker is unavailable.');
        return;
      }
      await addProjectFromPath(picked.path);
    } catch (err) {
      openManualProjectFallback(err instanceof Error ? err.message : 'Failed to add project');
    }
  };

  const handleManualProjectSubmit = (e: Event) => {
    e.preventDefault();
    addProjectFromPath(manualProjectPath);
  };

  const handleSubmit = async () => {
    const content = text.trim();
    if (!content || submitting) return;
    if (!canCreate) {
      toast.error('Not connected to server. Please wait...');
      return;
    }
    if (waitingForProjectGit) {
      toast.error('Checking the selected project. Please try again in a moment.');
      return;
    }
    setSubmitting(true);
    let createdSessionId: string | null = null;
    try {
      const req: CreateSessionRequest = {};
      if (selectedModel && selectedModelInfo) {
        req.config = {
          model: selectedModelInfo.id,
          provider: selectedModelInfo.provider as Provider,
        };
      }
      if (project) {
        req.workspacePath = project;
        if (gitInfo?.isGitRepo) {
          req.worktreeMode = mode;
          if (mode === 'worktree' && baseBranch) {
            req.worktreeBaseBranch = baseBranch;
          }
        }
      }
      const response = await createSession(req);
      if (!response?.sessionId) {
        toast.error('No sessionId in response');
        setSubmitting(false);
        return;
      }
      createdSessionId = response.sessionId;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new ConnectionNotReadyError('Not connected to server');
      await hub.request('message.send', { sessionId: response.sessionId, content });
      navigateToSession(response.sessionId);
    } catch (err) {
      if (createdSessionId) {
        toast.error('Chat was created, but the first message failed. Opened it so you can retry.');
        navigateToSession(createdSessionId);
        return;
      } else if (err instanceof ConnectionNotReadyError) {
        toast.error('Connection lost. Please try again.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to start chat');
      }
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div class="relative flex-1 flex flex-col bg-app-content overflow-hidden">
      <div class="desktop-empty-drag-strip" data-tauri-drag-region />

      <div class="md:hidden flex items-center px-3 py-2">
        <MobileMenuButton />
      </div>

      <div class="flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <h1 class="text-2xl md:text-3xl font-semibold text-gray-100 mb-8 text-center">
          What should we build?
        </h1>

        <div class="w-full max-w-2xl">
          <div class="bg-dark-800 border border-dark-700 rounded-2xl px-3 py-2.5 transition-colors focus-within:border-dark-600">
            <textarea
              value={text}
              onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything to start a new chat..."
              rows={3}
              disabled={submitting}
              autoFocus
              class="w-full bg-transparent resize-none px-1.5 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none disabled:opacity-60"
            />
            <div class="flex items-center justify-between gap-2 pt-1">
              <NewChatModelPicker
                activeModelInfo={activeModelInfo}
                activeModelLabel={activeModelLabel}
                availableModels={availableModels}
                loading={modelLoading}
                onSelectModel={(model) => {
                  if (!model.provider) {
                    toast.error('Model provider information is missing');
                    return;
                  }
                  setSelectedModel({ id: model.id, provider: model.provider });
                }}
              />
              <button
                type="button"
                data-testid="landing-send"
                onClick={handleSubmit}
                disabled={!text.trim() || submitting || !canCreate || waitingForProjectGit}
                title="Start chat"
                aria-label="Start chat"
                class="flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? (
                  <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      class="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      stroke-width="4"
                    />
                    <path
                      class="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                ) : (
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M12 19V5M5 12l7-7 7 7"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <div class="mt-2 px-1">
            <WorkspaceChips
              projects={projectPaths}
              selectedProject={project}
              gitInfo={gitInfo}
              gitLoading={gitLoading}
              mode={mode}
              baseBranch={baseBranch}
              onSelectProject={handleSelectProject}
              onBrowse={handleBrowse}
              onEnterPath={() => {
                setManualProjectOpen(true);
                setManualProjectError(null);
              }}
              nativeFolderPickerAvailable={nativeFolderPickerAvailable}
              onSelectMode={setMode}
              onSelectBranch={setBaseBranch}
            />
            {manualProjectOpen && (
              <form
                onSubmit={handleManualProjectSubmit}
                class="mt-2 max-w-lg rounded-xl border border-dark-700 bg-dark-800 p-2"
              >
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    value={manualProjectPath}
                    onInput={(e) => {
                      setManualProjectPath((e.currentTarget as HTMLInputElement).value);
                      setManualProjectError(null);
                    }}
                    placeholder="Project path"
                    autoFocus
                    class="min-w-0 flex-1 rounded-lg border border-dark-700 bg-dark-900 px-3 py-2 text-xs text-gray-100 placeholder-gray-600 focus:border-dark-600 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={manualProjectBusy}
                    class="rounded-lg bg-dark-700 px-3 py-2 text-xs font-medium text-gray-200 transition-colors hover:bg-dark-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {manualProjectBusy ? 'Adding…' : 'Add'}
                  </button>
                </div>
                <p class="mt-1.5 text-[11px] leading-4 text-gray-600">
                  Use an absolute path accessible to HyperNeo.
                </p>
                {manualProjectError && (
                  <p class="mt-1.5 text-[11px] leading-4 text-red-400">{manualProjectError}</p>
                )}
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
