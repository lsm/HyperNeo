import superpipe, { type PipelineAPI } from 'superpipe';
import type { ArtifactPreviewTarget } from './artifact-preview-store.ts';

export type PreviewWorkspaceFile = { readonly title: string } & (
  | { readonly artifactId: string; readonly reference?: never; readonly sessionId?: never }
  | {
      readonly reference: Extract<ArtifactPreviewTarget, { kind: 'reference' }>;
      readonly artifactId?: never;
      readonly sessionId?: never;
    }
  | { readonly sessionId: string; readonly artifactId?: never; readonly reference?: never }
);
export const sessionTabKey = (sessionId: string) => `session:${sessionId}`;
export const previewFileKey = (file: PreviewWorkspaceFile): string =>
  file.artifactId ??
  (file.sessionId
    ? sessionTabKey(file.sessionId)
    : `reference:${encodeURIComponent(JSON.stringify(file.reference))}`);
export type PreviewWorkspaceState = {
  readonly open: boolean;
  readonly files: readonly PreviewWorkspaceFile[];
  readonly selectedId: string | null;
};
export type PreviewWorkspaceEvent =
  | { kind: 'open' | 'update'; file: PreviewWorkspaceFile }
  | { kind: 'select'; key: string | null }
  | { kind: 'close'; key: string }
  | { kind: 'dismiss' };

type WorkspacePlan =
  | { kind: 'keep' | 'dismiss' }
  | { kind: 'open' | 'update'; file: PreviewWorkspaceFile; index: number }
  | { kind: 'select'; key: string | null }
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
      const index = state.files.findIndex(
        (file) => previewFileKey(file) === previewFileKey(event.file)
      );
      return event.kind === 'update' && index < 0 ? { kind: 'keep' } : { ...event, index };
    }
    case 'select':
      return event.key === null || state.files.some((file) => previewFileKey(file) === event.key)
        ? event
        : { kind: 'keep' };
    case 'close': {
      const index = state.files.findIndex((file) => previewFileKey(file) === event.key);
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
      return { ...state, open: true, selectedId: plan.key };
    case 'open':
    case 'update': {
      const files =
        plan.index < 0
          ? [...state.files, { ...plan.file }]
          : state.files[plan.index].title === plan.file.title &&
              state.files[plan.index].reference === plan.file.reference
            ? state.files
            : state.files.map((file, index) => (index === plan.index ? { ...plan.file } : file));
      return plan.kind === 'update'
        ? { ...state, files }
        : { open: true, files, selectedId: previewFileKey(plan.file) };
    }
    case 'close':
      if (state.files.length === 1) return emptyWorkspace();
      return {
        ...state,
        files: state.files.filter((_, index) => index !== plan.index),
        selectedId:
          state.selectedId === previewFileKey(state.files[plan.index])
            ? plan.index > 0
              ? previewFileKey(state.files[plan.index - 1])
              : null
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
