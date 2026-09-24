import { useEffect, useState } from 'preact/hooks';
import type {
  CloneChildrenChoice,
  CloneSummary,
  Session,
  WorkspaceHistoryEntry,
  WorktreeCommitStatus,
} from '@hyperneo/shared';
import { navigateToSession, navigateToSessions } from '../lib/router.ts';
import { sessions } from '../lib/state.ts';
import {
  getWorkspaceHistory,
  addWorkspaceToHistory,
  removeWorkspaceFromHistory,
  archiveSession,
} from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { invokeOperation } from '../lib/operations.ts';
import { isUserSession } from '../lib/session-utils.ts';
import { getCollapsedProjects, setCollapsedProjects } from '../lib/sidebar-prefs.ts';
import { projectRootOf, projectName } from '../lib/projects.ts';
import {
  hasNativeFolderPicker,
  NATIVE_FOLDER_PICKER_TIMEOUT_MS,
} from '../lib/runtime-capabilities.ts';
import SessionListItem from '../components/SessionListItem.tsx';
import { SessionProjectGroup } from '../components/SessionProjectGroup.tsx';
import { ArchiveConfirmDialog } from '../components/ArchiveConfirmDialog.tsx';
import { CloneChoiceDialog } from '../components/CloneChoiceDialog.tsx';

interface SessionsSidebarProps {
  onSessionSelect?: () => void;
  onClose?: () => void;
}

function lastActive(session: Session): number {
  const time = new Date(session.lastActiveAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

interface ProjectGroup {
  path: string;
  name: string;
  sessions: Session[];
  sortTime: number;
}

function buildView(
  sessionsList: Session[],
  history: WorkspaceHistoryEntry[]
): { projects: ProjectGroup[]; ungrouped: Session[]; childrenByParent: Map<string, Session[]> } {
  const byRoot = new Map<string, Session[]>();
  const ungrouped: Session[] = [];
  const ids = new Set(sessionsList.map((session) => session.id));
  const childrenByParent = new Map<string, Session[]>();

  for (const session of sessionsList) {
    const parentId = session.parentSessionId;
    if (parentId && ids.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(session);
      childrenByParent.set(parentId, siblings);
      continue;
    }
    const root = projectRootOf(session);
    if (root) {
      const existing = byRoot.get(root);
      if (existing) existing.push(session);
      else byRoot.set(root, [session]);
    } else {
      ungrouped.push(session);
    }
  }

  const historyTime = new Map<string, number>();
  for (const entry of history) {
    historyTime.set(entry.path, entry.lastUsedAt);
    if (!byRoot.has(entry.path)) byRoot.set(entry.path, []);
  }

  const projects: ProjectGroup[] = [...byRoot.entries()]
    .map(([path, grouped]) => {
      const sorted = grouped.slice().sort((a, b) => lastActive(b) - lastActive(a));
      const sortTime = sorted.length > 0 ? lastActive(sorted[0]) : (historyTime.get(path) ?? 0);
      return { path, name: projectName(path), sessions: sorted, sortTime };
    })
    .sort((a, b) => b.sortTime - a.sortTime);

  ungrouped.sort((a, b) => lastActive(b) - lastActive(a));
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => lastActive(b) - lastActive(a));
  }

  return { projects, ungrouped, childrenByParent };
}

export function SessionsSidebar({ onSessionSelect, onClose }: SessionsSidebarProps) {
  const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => getCollapsedProjects());
  const [archiveConfirm, setArchiveConfirm] = useState<{
    sessionId: string;
    commitStatus: WorktreeCommitStatus;
    children?: CloneChildrenChoice;
  } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [cloneChoice, setCloneChoice] = useState<{
    sessionId: string;
    clones: CloneSummary[];
  } | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectPath, setAddProjectPath] = useState('');
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [nativeFolderPickerAvailable] = useState(() => hasNativeFolderPicker());

  useEffect(() => {
    getWorkspaceHistory()
      .then(setHistory)
      .catch(() => {});
  }, []);

  const sessionsList = sessions.value.filter(isUserSession);
  const { projects, ungrouped, childrenByParent } = buildView(sessionsList, history);
  const hasContent = sessionsList.length > 0 || projects.length > 0;
  const childrenOf = (sessionId: string) => childrenByParent.get(sessionId) ?? [];

  const handleSessionClick = (sessionId: string) => {
    navigateToSession(sessionId);
    onSessionSelect?.();
  };

  const handleSpawn = async (parentSessionId: string) => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected');
      return;
    }
    try {
      const result = await invokeOperation<
        { accepted: true; sessionId: string } | { accepted: false; message: string }
      >(hub, 'session.clone.spawn', { parentSessionId });
      if (!result.accepted) throw new Error(result.message);
      navigateToSession(result.sessionId);
      onSessionSelect?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to spawn');
    }
  };

  const toggleProject = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      setCollapsedProjects(next);
      return next;
    });
  };

  const addProjectFromPath = async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      setAddProjectError('Enter an absolute project path.');
      return;
    }
    setAddProjectBusy(true);
    setAddProjectError(null);
    try {
      const entry = await addWorkspaceToHistory(trimmed);
      setHistory((prev) => [entry, ...prev.filter((e) => e.path !== entry.path)]);
      setAddProjectPath('');
      setAddProjectOpen(false);
    } catch (err) {
      setAddProjectOpen(true);
      setAddProjectError(err instanceof Error ? err.message : 'Failed to add project');
    } finally {
      setAddProjectBusy(false);
    }
  };

  const handleBrowseProject = async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      setAddProjectOpen(true);
      setAddProjectError('Not connected to server. Please wait...');
      return;
    }
    try {
      const picked = await hub.request<{ path: string | null }>('dialog.pickFolder', undefined, {
        timeout: NATIVE_FOLDER_PICKER_TIMEOUT_MS,
      });
      if (!picked?.path) {
        setAddProjectOpen(true);
        setAddProjectError('Enter a path manually if the folder picker is unavailable.');
        return;
      }
      await addProjectFromPath(picked.path);
    } catch (err) {
      setAddProjectOpen(true);
      setAddProjectError(err instanceof Error ? err.message : 'Failed to add project');
    }
  };

  const handleAddProjectSubmit = (e: Event) => {
    e.preventDefault();
    addProjectFromPath(addProjectPath);
  };

  const handleRemoveProject = async (path: string) => {
    try {
      await removeWorkspaceFromHistory(path);
      setHistory((prev) => prev.filter((e) => e.path !== path));
    } catch {
      toast.error('Failed to remove project');
    }
  };

  const handleArchive = async (sessionId: string, children?: CloneChildrenChoice) => {
    setArchiveBusy(true);
    try {
      const result = await archiveSession(sessionId, false, children);
      if (result.reason === 'has_clones' && result.clones) {
        setCloneChoice({ sessionId, clones: result.clones });
      } else if (result.requiresConfirmation && result.commitStatus) {
        setCloneChoice(null);
        setArchiveConfirm({ sessionId, commitStatus: result.commitStatus, children });
      } else if (result.success) {
        setCloneChoice(null);
        toast.success('Chat archived');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive chat');
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleConfirmArchive = async () => {
    if (!archiveConfirm) return;
    setArchiveBusy(true);
    try {
      const result = await archiveSession(archiveConfirm.sessionId, true, archiveConfirm.children);
      if (result.success) {
        toast.success('Chat archived');
        setArchiveConfirm(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive chat');
    } finally {
      setArchiveBusy(false);
    }
  };

  const handleNewChat = () => {
    navigateToSessions();
    onSessionSelect?.();
  };

  return (
    <div class="flex flex-col h-full">
      <div class="p-2">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            class="md:hidden mb-1 ml-auto flex p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-fill-soft transition-colors"
            title="Close panel"
            aria-label="Close panel"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
        <button
          type="button"
          data-testid="new-chat-button"
          onClick={handleNewChat}
          class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-fg-soft hover:bg-fill-soft hover:text-fg transition-colors"
        >
          <svg class="w-4 h-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
            />
          </svg>
          <span>New chat</span>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-2 pb-2">
        {!hasContent ? (
          <div class="px-2 py-10 text-center">
            <p class="text-sm text-fg-faint">No chats yet</p>
            <p class="text-xs text-fg-faint mt-1">Start a new chat to begin.</p>
          </div>
        ) : (
          <>
            <div class="flex items-center justify-between px-2.5 pt-2 pb-1">
              <span class="text-xs font-medium text-fg-faint">Projects</span>
              <button
                type="button"
                data-testid="add-project-button"
                onClick={() => {
                  setAddProjectError(null);
                  if (nativeFolderPickerAvailable) {
                    void handleBrowseProject();
                  } else {
                    setAddProjectOpen(true);
                  }
                }}
                title="Add project"
                aria-label="Add project"
                class="p-0.5 rounded text-fg-faint hover:text-fg-soft hover:bg-fill-soft transition-colors"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
              </button>
            </div>
            {addProjectOpen && (
              <form
                data-testid="add-project-form"
                onSubmit={handleAddProjectSubmit}
                class="mx-2 mb-2 rounded-lg border border-line bg-surface-overlay p-2"
              >
                <div class="flex items-center gap-1.5">
                  <input
                    type="text"
                    data-testid="add-project-path-input"
                    value={addProjectPath}
                    onInput={(e) => {
                      setAddProjectPath((e.currentTarget as HTMLInputElement).value);
                      setAddProjectError(null);
                    }}
                    placeholder="Project path"
                    autoFocus
                    class="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg placeholder-gray-600 focus:border-line-strong focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={addProjectBusy}
                    class="rounded-md bg-fill-strong px-2 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:bg-line-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {addProjectBusy ? 'Adding…' : 'Add'}
                  </button>
                </div>
                <p class="mt-1.5 text-[11px] leading-4 text-fg-faint">
                  Use an absolute path accessible to HyperNeo.
                </p>
                {addProjectError && (
                  <p class="mt-1.5 text-[11px] leading-4 text-danger">{addProjectError}</p>
                )}
              </form>
            )}
            {projects.length > 0 && (
              <div class="flex flex-col gap-0.5">
                {projects.map((project) => (
                  <SessionProjectGroup
                    key={project.path}
                    name={project.name}
                    path={project.path}
                    sessions={project.sessions}
                    collapsed={collapsed.has(project.path)}
                    onToggle={() => toggleProject(project.path)}
                    onSessionClick={handleSessionClick}
                    onArchive={handleArchive}
                    onSpawn={handleSpawn}
                    childrenOf={childrenOf}
                    onRemove={
                      project.sessions.length === 0
                        ? () => handleRemoveProject(project.path)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}

            {ungrouped.length > 0 && (
              <>
                <div class="px-2.5 pt-3 pb-1 text-xs font-medium text-fg-faint">Chats</div>
                <div class="flex flex-col gap-0.5">
                  {ungrouped.flatMap((session) => [
                    <SessionListItem
                      key={session.id}
                      session={session}
                      onSessionClick={handleSessionClick}
                      onArchive={handleArchive}
                      onSpawn={handleSpawn}
                    />,
                    ...childrenOf(session.id).map((child) => (
                      <SessionListItem
                        key={child.id}
                        session={child}
                        onSessionClick={handleSessionClick}
                        onArchive={handleArchive}
                        nested
                      />
                    )),
                  ])}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {cloneChoice && (
        <CloneChoiceDialog
          clones={cloneChoice.clones}
          action="archive"
          subject="session"
          busy={archiveBusy}
          onChoose={(choice) => handleArchive(cloneChoice.sessionId, choice)}
          onCancel={() => setCloneChoice(null)}
        />
      )}

      {archiveConfirm && (
        <ArchiveConfirmDialog
          commitStatus={archiveConfirm.commitStatus}
          archiving={archiveBusy}
          onConfirm={handleConfirmArchive}
          onCancel={() => setArchiveConfirm(null)}
        />
      )}
    </div>
  );
}
