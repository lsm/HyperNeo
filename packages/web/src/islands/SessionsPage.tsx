import { useEffect, useMemo, useState } from 'preact/hooks';
import { normalizeThinkingLevel } from '@hyperneo/shared';
import {
  isOxapHarness,
  oxapHarness,
  oxapCodexDefaultThinking,
  oxapThinkingOptions,
  oxapHarnessesForProvider,
  type OxapHarnessId,
} from '@hyperneo/shared/types/oxap-harnesses';
import type {
  CreateSessionRequest,
  GitBranchesResponse,
  ModelInfo,
  Provider,
  ThinkingLevel,
  WorkspaceHistoryEntry,
} from '@hyperneo/shared';
import { connectionState, globalSettings, sessions } from '../lib/state.ts';
import { navigateToSession } from '../lib/router.ts';
import { newChatProjectSignal, workspaceHistoryVersionSignal } from '../lib/signals.ts';
import {
  createSession,
  getWorkspaceHistory,
  getGitBranches,
  addWorkspaceToHistory,
  addFolderToProject,
  listProviders,
  type ListedProvider,
} from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { ConnectionNotReadyError } from '../lib/errors.ts';
import { isUserSession } from '../lib/session-utils.ts';
import { judgeFolderTarget, listProjectPaths, owningProjectName } from '../lib/projects.ts';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../lib/runtime-capabilities.ts';
import { MobileMenuButton } from '../components/ui/MobileMenuButton.tsx';
import { WorkspaceChips } from '../components/WorkspaceChips.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import { isCoarsePointer } from '../neo/useCoarsePointer.ts';
import { findDefaultModel, useModelSwitcher } from '../hooks/useModelSwitcher.ts';

type NewChatWorktreeMode = 'worktree' | 'direct';
type NewChatHarness = 'sdk' | OxapHarnessId;

const HARNESS_SETUP = 'Set up in Settings → Providers';
const CHAT_ICON_CONTROL =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border sm:pointer-coarse:size-11';

interface NewChatModelSelection {
  id: string;
  provider: string;
}

interface NewChatSelection {
  project: string | null;
  mode: NewChatWorktreeMode;
  baseBranch: string | null;
  model: NewChatModelSelection | null;
  thinkingLevel: ThinkingLevel | null;
  sandbox: boolean | null;
}

const NEW_CHAT_SELECTION_KEY = 'hyperneo_new_chat_selection';
const DEFAULT_NEW_CHAT_SELECTION: NewChatSelection = {
  project: null,
  mode: 'worktree',
  baseBranch: null,
  model: null,
  thinkingLevel: null,
  sandbox: null,
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
      thinkingLevel:
        typeof value.thinkingLevel === 'string'
          ? normalizeThinkingLevel(value.thinkingLevel)
          : null,
      sandbox: typeof value.sandbox === 'boolean' ? value.sandbox : null,
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

function getModelLabel(modelInfo: ModelInfo | null, fallbackModelId: string | undefined): string {
  if (modelInfo) return modelInfo.name;
  if (fallbackModelId) return fallbackModelId.replace(/-/g, ' ');
  return 'Model';
}

export function SessionsPage() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [initialSelection] = useState<NewChatSelection>(() => loadNewChatSelection());
  const { availableModels, loading: modelLoading, reload: reloadModels } = useModelSwitcher(null);

  const [providers, setProviders] = useState<ListedProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providersRetry, setProvidersRetry] = useState(0);
  const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [project, setProject] = useState<string | null>(initialSelection.project);
  const [gitInfo, setGitInfo] = useState<GitBranchesResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [mode, setMode] = useState<NewChatWorktreeMode>(initialSelection.mode);
  const [baseBranch, setBaseBranch] = useState<string | null>(initialSelection.baseBranch);
  const [manualProjectOpen, setManualProjectOpen] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderProject, setFolderProject] = useState<string | null>(null);
  const [manualProjectPath, setManualProjectPath] = useState('');
  const [manualProjectError, setManualProjectError] = useState<string | null>(null);
  const [manualProjectBusy, setManualProjectBusy] = useState(false);
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());
  const [selectedModel, setSelectedModel] = useState<NewChatModelSelection | null>(
    initialSelection.model
  );
  const [selectedThinking, setSelectedThinking] = useState<ThinkingLevel | null>(
    initialSelection.thinkingLevel
  );
  const [harnessChoice, setHarnessChoice] = useState<{ provider: string; id: NewChatHarness }>();
  const [sandboxChoice, setSandboxChoice] = useState<boolean | null>(initialSelection.sandbox);
  const sandbox = sandboxChoice ?? globalSettings.value?.sandbox?.enabled ?? false;

  const canCreate = connectionState.value === 'connected';
  const waitingForProjectGit = project !== null && gitLoading;

  const projectPaths = listProjectPaths(sessions.value.filter(isUserSession), history);
  const defaultModelId = globalSettings.value?.model ?? 'sonnet';
  const selectedModelInfo = useMemo(
    () => findModelInfo(availableModels, selectedModel),
    [availableModels, selectedModel]
  );
  const defaultModelInfo = useMemo(
    () => findDefaultModel(availableModels, defaultModelId, globalSettings.value?.modelProvider),
    [availableModels, defaultModelId, globalSettings.value?.modelProvider]
  );
  const activeModelInfo = selectedModelInfo ?? defaultModelInfo;
  const providerId =
    (selectedModel && selectedModelInfo
      ? selectedModelInfo.provider
      : globalSettings.value?.modelProvider) ?? activeModelInfo?.provider;
  const eligibleHarnesses = oxapHarnessesForProvider(providerId ?? '');
  const mayUseOxap = eligibleHarnesses.length > 0;
  const provider = providers?.find((record) => record.providerId === providerId);
  let configuredHarness: unknown;
  try {
    configuredHarness = JSON.parse(provider?.configJson ?? '{}').harness;
  } catch {}
  const defaultHarness =
    isOxapHarness(configuredHarness) && eligibleHarnesses.includes(configuredHarness)
      ? configuredHarness
      : 'sdk';
  const harness =
    harnessChoice?.provider === providerId && harnessChoice ? harnessChoice.id : defaultHarness;
  const engine = isOxapHarness(harness) ? oxapHarness(harness) : undefined;
  const isOxap = engine !== undefined;
  const ready = (id: OxapHarnessId) => provider?.readyHarnesses?.includes(id) === true;
  const harnessUnavailable = isOxapHarness(harness) && !ready(harness);
  const harnessLabel = engine?.label ?? 'Claude Code';
  const thinkingOptions = oxapThinkingOptions(harness, activeModelInfo);
  const supportedThinking = thinkingOptions.some(({ value }) => value === selectedThinking)
    ? selectedThinking
    : null;
  const thinkingLevel =
    supportedThinking ??
    (harness === 'oxap-codex'
      ? (oxapCodexDefaultThinking(activeModelInfo) ?? 'off')
      : normalizeThinkingLevel(globalSettings.value?.thinkingLevel));
  const chooseHarness = (id: NewChatHarness) => {
    if (providerId)
      setHarnessChoice(id === defaultHarness ? undefined : { provider: providerId, id });
  };

  useEffect(() => {
    setHarnessChoice(undefined);
  }, [providerId]);

  useEffect(() => {
    if (connectionState.value !== 'connected') return;
    let active = true;
    let request = 0;
    const load = () => {
      const current = ++request;
      setProviders(null);
      setProvidersError(null);
      void listProviders({ forNewSession: true })
        .then(({ providers }) => {
          if (active && current === request) setProviders(providers);
        })
        .catch((error: unknown) => {
          if (active && current === request) {
            setProvidersError(error instanceof Error ? error.message : 'Could not load providers');
          }
        });
    };
    load();
    const unsubscribe = connectionManager.getHubIfConnected()?.onEvent('providers.changed', load);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [connectionState.value, providersRetry]);

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

  const historyVersion = workspaceHistoryVersionSignal.value;
  useEffect(() => {
    getWorkspaceHistory()
      .then((entries) => {
        setHistory(entries);
        setHistoryLoaded(true);
      })
      .catch(() => {});
  }, [historyVersion]);

  const requestedProject = newChatProjectSignal.value;
  useEffect(() => {
    if (!requestedProject) return;
    setProject(requestedProject);
    newChatProjectSignal.value = null;
  }, [requestedProject]);

  useEffect(() => {
    saveNewChatSelection({
      project,
      mode,
      baseBranch,
      model: selectedModel,
      thinkingLevel: selectedThinking,
      sandbox: sandboxChoice,
    });
  }, [project, mode, baseBranch, selectedModel, selectedThinking, sandboxChoice]);

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

  const addFolderToSelectedProject = async (path: string) => {
    const trimmed = path.trim();
    const target = folderProject ?? project;
    if (!target || !trimmed) {
      setManualProjectError('Enter an absolute folder path.');
      return;
    }
    setManualProjectBusy(true);
    setManualProjectError(null);
    let fresh: WorkspaceHistoryEntry[] | null = null;
    try {
      fresh = await getWorkspaceHistory();
    } catch {}
    const verdict = judgeFolderTarget(target, fresh, history, historyLoaded);
    if (verdict.decision === 'refuse') {
      setManualProjectBusy(false);
      setManualProjectError(verdict.message);
      return;
    }
    try {
      await addFolderToProject(target, trimmed);
      setManualProjectPath('');
      setManualProjectOpen(false);
      workspaceHistoryVersionSignal.value += 1;
    } catch (err) {
      setManualProjectError(err instanceof Error ? err.message : 'Failed to add folder');
    } finally {
      setManualProjectBusy(false);
    }
  };

  const openManualProjectFallback = (message?: string) => {
    setAddingFolder(false);
    setFolderProject(null);
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
    if (addingFolder) addFolderToSelectedProject(manualProjectPath);
    else addProjectFromPath(manualProjectPath);
  };

  const handleSubmit = async () => {
    const content = text.trim();
    if (!content || submitting || harnessUnavailable || (mayUseOxap && providers === null)) return;
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
      if (harness !== defaultHarness) req.harness = harness;
      if ((selectedModel && selectedModelInfo) || req.harness) {
        req.config = { provider: providerId as Provider };
        if (activeModelInfo) req.config.model = activeModelInfo.id;
      }
      if (supportedThinking) {
        req.config = { ...req.config, thinkingLevel: supportedThinking };
      }
      if (!isOxap && sandboxChoice !== null) {
        req.config = { ...req.config, sandbox: { enabled: sandboxChoice } };
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
        <h1 class="text-2xl md:text-3xl font-semibold text-fg mb-8 text-center">
          What should we build?
        </h1>

        <div class="w-full max-w-2xl">
          <div class="bg-surface-raised border border-line rounded-2xl px-3 py-2.5 transition-colors focus-within:border-line-strong">
            <textarea
              value={text}
              onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything to start a new chat..."
              rows={3}
              disabled={submitting}
              autoFocus={!isCoarsePointer()}
              class="w-full bg-transparent resize-none px-1.5 py-1 text-sm text-fg placeholder:text-fg-faint focus:outline-none disabled:opacity-60"
            />
            <div class="flex items-center justify-between gap-2 pt-1">
              <div class="flex min-w-0 items-center gap-2">
                <ModelPicker
                  menuId="new-chat-preferences"
                  align="trigger"
                  newChatHarness={{
                    label: harnessLabel,
                    readyProviders: providers
                      ?.filter((record) => record.readyHarnesses?.length)
                      .map((record) => record.providerId),
                    options:
                      mayUseOxap && providers !== null
                        ? [
                            {
                              label: 'Claude Code',
                              selected: harness === 'sdk',
                              onSelect: () => chooseHarness('sdk'),
                            },
                            ...eligibleHarnesses.map((id) => ({
                              label: oxapHarness(id).label,
                              selected: harness === id,
                              unavailableReason: ready(id) ? undefined : HARNESS_SETUP,
                              onSelect: () => chooseHarness(id),
                            })),
                          ]
                        : [],
                  }}
                  activeModelInfo={activeModelInfo}
                  activeModelLabel={activeModelLabel}
                  availableModels={availableModels}
                  loading={modelLoading}
                  thinkingLevel={thinkingLevel}
                  thinkingOptions={thinkingOptions}
                  showCodexUltraNote={harness === 'oxap-codex'}
                  onSelectThinking={setSelectedThinking}
                  onReload={() => void reloadModels()}
                  onSelectModel={(model) => {
                    if (!model.provider) {
                      toast.error('Model provider information is missing');
                      return;
                    }
                    setSelectedModel({ id: model.id, provider: model.provider });
                  }}
                />
                {!isOxap && (
                  <button
                    type="button"
                    aria-label="Sandbox"
                    aria-pressed={sandbox}
                    onClick={() => setSandboxChoice(!sandbox)}
                    title={sandbox ? 'Sandbox on: commands run isolated' : 'Sandbox off'}
                    class={`${CHAT_ICON_CONTROL} transition-colors ${
                      sandbox
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'border-line text-fg-muted hover:text-fg'
                    }`}
                  >
                    <svg
                      aria-hidden="true"
                      class="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width={2}
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                  </button>
                )}
              </div>
              <button
                type="button"
                data-testid="landing-send"
                onClick={handleSubmit}
                disabled={
                  !text.trim() ||
                  submitting ||
                  !canCreate ||
                  waitingForProjectGit ||
                  harnessUnavailable ||
                  (mayUseOxap && providers === null)
                }
                title="Start chat"
                aria-label="Start chat"
                class="flex items-center justify-center w-8 h-8 shrink-0 rounded-full bg-accent-hover sm:pointer-coarse:size-11 text-accent-fg transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
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

          {harnessUnavailable && providers !== null && (
            <p class="mt-2 px-1 text-xs text-fg-muted">{HARNESS_SETUP}</p>
          )}
          {providersError && (
            <p role="alert" class="mt-2 px-1 text-sm text-danger">
              {providersError}{' '}
              <button type="button" onClick={() => setProvidersRetry((value) => value + 1)}>
                Retry
              </button>
            </p>
          )}
          <div class="mt-2 px-1">
            <WorkspaceChips
              projects={projectPaths}
              selectedProject={project}
              gitInfo={gitInfo}
              gitLoading={gitLoading}
              mode={mode}
              baseBranch={baseBranch}
              onSelectProject={handleSelectProject}
              owningProjectName={(path) => owningProjectName(path, history)}
              onBrowse={handleBrowse}
              onEnterPath={() => {
                setAddingFolder(false);
                setFolderProject(null);
                setManualProjectOpen(true);
                setManualProjectError(null);
              }}
              onAddFolder={() => {
                setAddingFolder(true);
                setFolderProject(project);
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
                class="mt-2 max-w-lg rounded-xl border border-line bg-surface-raised p-2"
              >
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    value={manualProjectPath}
                    onInput={(e) => {
                      setManualProjectPath((e.currentTarget as HTMLInputElement).value);
                      setManualProjectError(null);
                    }}
                    placeholder={addingFolder ? 'Folder path' : 'Project path'}
                    autoFocus
                    class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg placeholder:text-fg-faint focus:border-line-strong focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={manualProjectBusy}
                    class="rounded-lg bg-fill-strong px-3 py-2 text-xs font-medium text-fg-soft transition-colors hover:bg-line-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {manualProjectBusy ? 'Adding…' : 'Add'}
                  </button>
                </div>
                <p class="mt-1.5 text-[11px] leading-4 text-fg-faint">
                  {addingFolder && folderProject
                    ? `Adds a folder to ${owningProjectName(folderProject, history)}. Use an absolute path accessible to HyperNeo.`
                    : 'Use an absolute path accessible to HyperNeo.'}
                </p>
                {manualProjectError && (
                  <p class="mt-1.5 text-[11px] leading-4 text-danger">{manualProjectError}</p>
                )}
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
