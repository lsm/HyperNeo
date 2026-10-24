import superpipe, { type PipelineAPI } from 'superpipe';

export type PreviewWorkspaceFile = { readonly artifactId: string; readonly title: string };
export type PreviewWorkspaceState = {
  readonly open: boolean;
  readonly files: readonly PreviewWorkspaceFile[];
  readonly selectedId: string | null;
};
export type PreviewWorkspaceEvent =
  | { kind: 'open' | 'update'; file: PreviewWorkspaceFile }
  | { kind: 'select'; artifactId: string | null }
  | { kind: 'close'; artifactId: string }
  | { kind: 'dismiss' };

type WorkspacePlan =
  | { kind: 'keep' | 'dismiss' }
  | { kind: 'open' | 'update'; file: PreviewWorkspaceFile; index: number }
  | { kind: 'select'; artifactId: string | null }
  | { kind: 'close'; index: number };

function emptyWorkspace(): PreviewWorkspaceState {
  return { open: false, files: [], selectedId: null };
}

function planWorkspaceEvent(
  state: PreviewWorkspaceState,
  event: PreviewWorkspaceEvent
): WorkspacePlan {
  switch (event.kind) {
    case 'open':
    case 'update': {
      const index = state.files.findIndex((file) => file.artifactId === event.file.artifactId);
      return event.kind === 'update' && index < 0 ? { kind: 'keep' } : { ...event, index };
    }
    case 'select':
      return event.artifactId === null ||
        state.files.some((file) => file.artifactId === event.artifactId)
        ? event
        : { kind: 'keep' };
    case 'close': {
      const index = state.files.findIndex((file) => file.artifactId === event.artifactId);
      return index < 0 ? { kind: 'keep' } : { kind: 'close', index };
    }
    case 'dismiss':
      return event;
  }
}

function applyWorkspacePlan(
  state: PreviewWorkspaceState,
  plan: WorkspacePlan
): PreviewWorkspaceState {
  switch (plan.kind) {
    case 'keep':
      return state;
    case 'dismiss':
      return emptyWorkspace();
    case 'select':
      return { ...state, open: true, selectedId: plan.artifactId };
    case 'open':
    case 'update': {
      const files =
        plan.index < 0
          ? [...state.files, { ...plan.file }]
          : state.files[plan.index].title === plan.file.title
            ? state.files
            : state.files.map((file, index) => (index === plan.index ? { ...plan.file } : file));
      return plan.kind === 'update'
        ? { ...state, files }
        : { open: true, files, selectedId: plan.file.artifactId };
    }
    case 'close':
      return {
        ...state,
        files: state.files.filter((_, index) => index !== plan.index),
        selectedId:
          state.selectedId === state.files[plan.index].artifactId
            ? (state.files[plan.index - 1]?.artifactId ?? null)
            : state.selectedId,
      };
  }
}

const step = (superpipe({})('preview-workspace-step') as PipelineAPI)
  .input(['state', 'event'])
  .pipe(planWorkspaceEvent, ['state', 'event'], 'plan')
  .pipe(applyWorkspacePlan, ['state', 'plan'], 'updated')
  .end('updated') as (
  state: PreviewWorkspaceState,
  event: PreviewWorkspaceEvent
) => PreviewWorkspaceState;

export const previewWorkspace = { empty: emptyWorkspace, step };
