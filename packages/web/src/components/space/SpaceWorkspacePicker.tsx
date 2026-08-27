import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitBranchesResponse, SpaceWorkspace } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../../lib/connection-manager';
import { connectionState } from '../../lib/state';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';

export type SpaceWorkspaceOption = Pick<SpaceWorkspace, 'id' | 'path' | 'label' | 'isPrimary'>;

interface SpaceWorkspaceRegistryState {
  spaceId: string;
  settled: boolean;
  list: SpaceWorkspaceOption[] | null;
}

interface SpaceWorkspaceRegistryGate {
  spaceId: string;
  connected: boolean;
  started: boolean;
  done: boolean;
  promise: Promise<void>;
  resolve: () => void;
}

function workspaceLabel(workspace: SpaceWorkspaceOption): string {
  if (workspace.label) return workspace.label;
  return workspace.path.split('/').filter(Boolean).at(-1) ?? workspace.path;
}

function primaryFirst(list: SpaceWorkspaceOption[]): SpaceWorkspaceOption[] {
  return [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

function armGate(spaceId: string, connected: boolean): SpaceWorkspaceRegistryGate {
  let resolveGate: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  return { spaceId, connected, started: false, done: false, promise, resolve: resolveGate };
}

function releaseGate(gate: SpaceWorkspaceRegistryGate): void {
  if (gate.done) return;
  gate.done = true;
  gate.resolve();
}

function useSpaceWorkspaceRegistry(
  spaceId: string,
  fallbackPath?: string | null
): {
  options: SpaceWorkspaceOption[];
  settle: () => Promise<void>;
  refresh: () => void;
} {
  const [state, setState] = useState<SpaceWorkspaceRegistryState | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const gateRef = useRef<SpaceWorkspaceRegistryGate | null>(null);

  const connected = connectionState.value === 'connected';

  const installGate = (gate: SpaceWorkspaceRegistryGate) => {
    const superseded = gateRef.current;
    gateRef.current = gate;
    if (superseded && superseded !== gate) releaseGate(superseded);
  };

  if (gateRef.current?.spaceId !== spaceId || gateRef.current.connected !== connected) {
    installGate(armGate(spaceId, connected));
  }

  const startLookup = (gate: SpaceWorkspaceRegistryGate) => {
    if (gate.started) return;
    gate.started = true;
    const settleGate = () => {
      releaseGate(gate);
    };
    const apply = (list: SpaceWorkspaceOption[] | null) => {
      if (gateRef.current !== gate) return;
      setState({ spaceId, settled: true, list });
    };
    const hub = gate.connected ? connectionManager.getHubIfConnected() : null;
    if (!hub) {
      const settledForSpace = stateRef.current?.spaceId === spaceId && stateRef.current.settled;
      if (!settledForSpace) apply(null);
      settleGate();
      return;
    }
    hub
      .request<SpaceWorkspaceOption[]>('space.workspace.list', { spaceId })
      .then((list) => apply(list.length > 0 ? primaryFirst(list) : null))
      .catch(() => apply(null))
      .finally(() => settleGate());
  };

  useEffect(() => {
    const gate = gateRef.current;
    if (!gate) return;
    startLookup(gate);
    return () => {
      releaseGate(gate);
    };
  }, [spaceId, connected]);

  const refresh = () => {
    const gate = armGate(spaceId, connected);
    installGate(gate);
    startLookup(gate);
  };

  let options: SpaceWorkspaceOption[] = [];
  if (state?.spaceId === spaceId && state.settled) {
    if (state.list) {
      options = state.list;
    } else if (fallbackPath) {
      options = [{ id: `${spaceId}:primary`, path: fallbackPath, label: '', isPrimary: true }];
    }
  }

  const settle = async () => {
    for (;;) {
      const gate = gateRef.current;
      if (!gate) return;
      await gate.promise;
      if (gateRef.current === gate) return;
    }
  };

  return { options, settle, refresh };
}

async function resolveWorktreeMode(
  workspacePath: string,
  mode: 'worktree' | 'direct'
): Promise<'worktree' | 'direct' | undefined> {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return undefined;
  try {
    const info = await hub.request<GitBranchesResponse>('git.branches', { path: workspacePath });
    return info.isGitRepo ? mode : undefined;
  } catch {
    return undefined;
  }
}

interface SpaceWorkspacePickerDialogProps {
  isOpen: boolean;
  workspaces: SpaceWorkspaceOption[];
  onClose: () => void;
  onCreate: (workspacePath: string, mode: 'worktree' | 'direct') => void;
}

function SpaceWorkspacePickerDialog({
  isOpen,
  workspaces,
  onClose,
  onCreate,
}: SpaceWorkspacePickerDialogProps) {
  const [mode, setMode] = useState<'worktree' | 'direct'>('worktree');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create session" size="md">
      <p class="mb-3 text-sm text-gray-400">Choose a workspace for the new session.</p>
      <div class="space-y-2" data-testid="space-workspace-options">
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => onCreate(workspace.path, mode)}
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
      <div class="mt-4 flex items-center justify-between gap-3" data-testid="space-workspace-mode">
        <span class="text-xs text-gray-400">Session mode</span>
        <div class="flex items-center gap-2">
          <Button
            variant={mode === 'worktree' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMode('worktree')}
            title="Run in a separate git worktree, safely isolated from your checkout"
            data-testid="space-workspace-mode-worktree"
          >
            Worktree
          </Button>
          <Button
            variant={mode === 'direct' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMode('direct')}
            title="Work directly in the folder on its current branch"
            data-testid="space-workspace-mode-direct"
          >
            Direct
          </Button>
        </div>
      </div>
      <div class="mt-4">
        <Button variant="secondary" onClick={onClose} fullWidth>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

interface ChooseWorkspaceCtx {
  inFlight: boolean;
  refresh: () => void;
  settle: () => Promise<void>;
  readOptions: () => SpaceWorkspaceOption[];
  openPicker: (options: SpaceWorkspaceOption[]) => void;
  create: (workspacePath?: string, worktreeMode?: 'worktree' | 'direct') => void;
  options: SpaceWorkspaceOption[];
  choice: 'picker' | 'direct';
}

function refreshWorkspaceRegistry(ctx: ChooseWorkspaceCtx): ChooseWorkspaceCtx {
  ctx.refresh();
  return ctx;
}

async function awaitWorkspaceRegistry(ctx: ChooseWorkspaceCtx): Promise<ChooseWorkspaceCtx> {
  await ctx.settle();
  return ctx;
}

function decideWorkspaceChoice(ctx: ChooseWorkspaceCtx): ChooseWorkspaceCtx {
  const options = ctx.readOptions();
  return { ...ctx, options, choice: options.length > 1 ? 'picker' : 'direct' };
}

function applyWorkspaceChoice(ctx: ChooseWorkspaceCtx): ChooseWorkspaceCtx {
  if (ctx.choice === 'picker') {
    ctx.openPicker(ctx.options);
  } else {
    ctx.create(ctx.options[0]?.path);
  }
  return ctx;
}

const runChooseWorkspace = (
  superpipe({
    isDuplicateChoice: (ctx: ChooseWorkspaceCtx) => ctx.inFlight,
  })('choose-workspace') as PipelineAPI
)
  .input(['ctx'])
  .pipe('!isDuplicateChoice', 'ctx')
  .pipe(refreshWorkspaceRegistry, 'ctx', 'ctx')
  .pipe(awaitWorkspaceRegistry, 'ctx', 'ctx')
  .pipe(decideWorkspaceChoice, 'ctx', 'ctx')
  .pipe(applyWorkspaceChoice, 'ctx', 'ctx')
  .endAsync('ctx') as (input: ChooseWorkspaceCtx) => Promise<ChooseWorkspaceCtx>;

export function useSpaceWorkspaceChoice(
  spaceId: string,
  fallbackPath?: string | null,
  choiceScope = spaceId
) {
  const { options, settle, refresh } = useSpaceWorkspaceRegistry(spaceId, fallbackPath);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingCreateRef = useRef<
    ((workspacePath: string, worktreeMode?: 'worktree' | 'direct') => void) | null
  >(null);
  const choosingEpochRef = useRef<number | null>(null);
  const epochRef = useRef(0);
  const epochScopeRef = useRef(choiceScope);

  if (epochScopeRef.current !== choiceScope) {
    epochScopeRef.current = choiceScope;
    epochRef.current += 1;
    pendingCreateRef.current = null;
    choosingEpochRef.current = null;
  }

  useEffect(() => {
    setPickerOpen(false);
    return () => {
      if (epochScopeRef.current === choiceScope) {
        epochRef.current += 1;
      }
    };
  }, [choiceScope]);

  const closePicker = () => {
    pendingCreateRef.current = null;
    setPickerOpen(false);
  };

  const chooseWorkspace = (
    create: (workspacePath?: string, worktreeMode?: 'worktree' | 'direct') => void
  ) => {
    const inFlight = choosingEpochRef.current !== null;
    const epoch = epochRef.current;
    choosingEpochRef.current = epoch;
    void runChooseWorkspace({
      inFlight,
      refresh,
      settle,
      readOptions: () => optionsRef.current,
      openPicker: () => {
        if (epochRef.current !== epoch) {
          if (choosingEpochRef.current === epoch) choosingEpochRef.current = null;
          return;
        }
        choosingEpochRef.current = null;
        pendingCreateRef.current = (workspacePath: string, worktreeMode?: 'worktree' | 'direct') =>
          create(workspacePath, worktreeMode);
        setPickerOpen(true);
      },
      create: (workspacePath) => {
        if (epochRef.current !== epoch) {
          if (choosingEpochRef.current === epoch) choosingEpochRef.current = null;
          return;
        }
        choosingEpochRef.current = null;
        create(workspacePath);
      },
      options: [],
      choice: 'direct',
    });
  };

  const dialog = pickerOpen ? (
    <SpaceWorkspacePickerDialog
      isOpen={pickerOpen}
      workspaces={options}
      onClose={closePicker}
      onCreate={(workspacePath, mode) => {
        const create = pendingCreateRef.current;
        closePicker();
        void resolveWorktreeMode(workspacePath, mode).then((worktreeMode) => {
          create?.(workspacePath, worktreeMode);
        });
      }}
    />
  ) : null;

  return { chooseWorkspace, dialog };
}
