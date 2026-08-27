import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpaceWorkspace } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';

export type SpaceWorkspaceOption = Pick<SpaceWorkspace, 'id' | 'path' | 'label' | 'isPrimary'>;

function workspaceLabel(workspace: SpaceWorkspaceOption): string {
  if (workspace.label) return workspace.label;
  return workspace.path.split('/').filter(Boolean).at(-1) ?? workspace.path;
}

export function useSpaceWorkspaceOptions(
  spaceId: string,
  fallbackPath?: string | null
): SpaceWorkspaceOption[] {
  const [workspaces, setWorkspaces] = useState<SpaceWorkspaceOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    hub
      .request<SpaceWorkspaceOption[]>('space.workspace.list', { spaceId })
      .then((list) => {
        if (!cancelled && list.length > 0) {
          setWorkspaces([...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  if (workspaces) return workspaces;
  return fallbackPath
    ? [{ id: `${spaceId}:primary`, path: fallbackPath, label: '', isPrimary: true }]
    : [];
}

interface SpaceWorkspacePickerDialogProps {
  isOpen: boolean;
  workspaces: SpaceWorkspaceOption[];
  onClose: () => void;
  onCreate: (workspacePath: string) => void;
}

function SpaceWorkspacePickerDialog({
  isOpen,
  workspaces,
  onClose,
  onCreate,
}: SpaceWorkspacePickerDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create session" size="md">
      <p class="mb-3 text-sm text-gray-400">Choose a workspace for the new session.</p>
      <div class="space-y-2" data-testid="space-workspace-options">
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => onCreate(workspace.path)}
            data-testid="space-workspace-option"
            class={cn(
              'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70',
              workspace.isPrimary
                ? 'border-blue-800/40 bg-blue-950/20 hover:bg-blue-950/30'
                : 'border-dark-600 bg-dark-850 hover:border-dark-500 hover:bg-white/[0.04]'
            )}
          >
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="truncate text-sm font-medium text-gray-200">
                  {workspaceLabel(workspace)}
                </span>
                {workspace.isPrimary && (
                  <span
                    class="flex-shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-300"
                    data-testid="space-workspace-primary"
                  >
                    Primary
                  </span>
                )}
              </span>
              <span class="block truncate font-mono text-xs text-gray-400">{workspace.path}</span>
            </span>
          </button>
        ))}
      </div>
      <div class="mt-4">
        <Button variant="secondary" onClick={onClose} fullWidth>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

export function useSpaceWorkspaceChoice(spaceId: string, fallbackPath?: string | null) {
  const workspaces = useSpaceWorkspaceOptions(spaceId, fallbackPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingCreateRef = useRef<((workspacePath: string) => void) | null>(null);

  const chooseWorkspace = (create: (workspacePath?: string) => void) => {
    if (workspaces.length > 1) {
      pendingCreateRef.current = (workspacePath: string) => create(workspacePath);
      setPickerOpen(true);
    } else {
      create(workspaces[0]?.path);
    }
  };

  const closePicker = () => {
    pendingCreateRef.current = null;
    setPickerOpen(false);
  };

  const dialog = (
    <SpaceWorkspacePickerDialog
      isOpen={pickerOpen}
      workspaces={workspaces}
      onClose={closePicker}
      onCreate={(workspacePath) => {
        const create = pendingCreateRef.current;
        closePicker();
        create?.(workspacePath);
      }}
    />
  );

  return { chooseWorkspace, dialog };
}
