import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpaceWorkspace } from '@hyperneo/shared';
import { connectionManager } from '../../lib/connection-manager';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';

export type SpaceWorkspaceOption = Pick<SpaceWorkspace, 'id' | 'path' | 'label' | 'isPrimary'>;

interface SpaceWorkspaceRegistryState {
  spaceId: string;
  settled: boolean;
  list: SpaceWorkspaceOption[] | null;
}

function workspaceLabel(workspace: SpaceWorkspaceOption): string {
  if (workspace.label) return workspace.label;
  return workspace.path.split('/').filter(Boolean).at(-1) ?? workspace.path;
}

function primaryFirst(list: SpaceWorkspaceOption[]): SpaceWorkspaceOption[] {
  return [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

function useSpaceWorkspaceRegistry(
  spaceId: string,
  fallbackPath?: string | null
): { options: SpaceWorkspaceOption[]; settle: () => Promise<void> } {
  const [state, setState] = useState<SpaceWorkspaceRegistryState | null>(null);
  const settleRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let markSettled: () => void = () => {};
    settleRef.current = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const finish = (list: SpaceWorkspaceOption[] | null) => {
      if (cancelled) return;
      setState({ spaceId, settled: true, list });
      markSettled();
    };
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      finish(null);
      return;
    }
    hub
      .request<SpaceWorkspaceOption[]>('space.workspace.list', { spaceId })
      .then((list) => finish(list.length > 0 ? primaryFirst(list) : null))
      .catch(() => finish(null));
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  let options: SpaceWorkspaceOption[] = [];
  if (state?.spaceId === spaceId && state.settled) {
    if (state.list) {
      options = state.list;
    } else if (fallbackPath) {
      options = [{ id: `${spaceId}:primary`, path: fallbackPath, label: '', isPrimary: true }];
    }
  }

  return { options, settle: () => settleRef.current };
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
  const { options, settle } = useSpaceWorkspaceRegistry(spaceId, fallbackPath);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingCreateRef = useRef<((workspacePath: string) => void) | null>(null);
  const choosingRef = useRef(false);

  useEffect(() => {
    pendingCreateRef.current = null;
    choosingRef.current = false;
    setPickerOpen(false);
  }, [spaceId]);

  const closePicker = () => {
    pendingCreateRef.current = null;
    setPickerOpen(false);
  };

  const chooseWorkspace = (create: (workspacePath?: string) => void) => {
    if (choosingRef.current) return;
    choosingRef.current = true;
    void (async () => {
      try {
        await settle();
        const current = optionsRef.current;
        if (current.length > 1) {
          pendingCreateRef.current = (workspacePath: string) => create(workspacePath);
          setPickerOpen(true);
        } else {
          create(current[0]?.path);
        }
      } finally {
        choosingRef.current = false;
      }
    })();
  };

  const dialog = (
    <SpaceWorkspacePickerDialog
      isOpen={pickerOpen}
      workspaces={options}
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
