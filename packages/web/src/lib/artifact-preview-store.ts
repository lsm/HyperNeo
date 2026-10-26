import { batch, signal } from '@preact/signals';
import {
  previewWorkspace,
  type PreviewWorkspaceEvent,
  type PreviewWorkspaceFile,
} from './artifact-preview-workspace.ts';

/** @public */
export { previewWorkspace } from './artifact-preview-workspace.ts';

export type ArtifactPreviewSource = {
  kind: 'message' | 'publication' | 'todo';
  id: string;
  revisionId?: string;
};

export type ArtifactPreviewContext = { kind: 'todo' | 'ask'; id: string };

export type ArtifactPreviewTarget =
  | { kind: 'artifact'; artifactId: string }
  | {
      kind: 'reference';
      source: ArtifactPreviewSource;
      reference: string;
      file?: { path: string; headSha: string };
      context?: ArtifactPreviewContext;
    };

export const artifactPreviewStack = signal<readonly ArtifactPreviewTarget[]>([]);
const workspaceState = signal(previewWorkspace.empty());

function writePreviewStack(stack: readonly ArtifactPreviewTarget[], title?: string) {
  batch(() => {
    artifactPreviewStack.value = stack;
    const top = stack.at(-1);
    if (!top)
      workspaceState.value = previewWorkspace.step(workspaceState.value, { kind: 'dismiss' });
    else if (top.kind === 'artifact') {
      const known = workspaceState.value.files.find((file) => file.artifactId === top.artifactId);
      workspaceState.value = previewWorkspace.step(workspaceState.value, {
        kind: 'open',
        file: { artifactId: top.artifactId, title: title ?? known?.title ?? '' },
      });
    }
  });
}

function navigateWorkspace(event: PreviewWorkspaceEvent & { kind: 'select' | 'close' | 'update' }) {
  batch(() => {
    const before = workspaceState.value;
    const after = previewWorkspace.step(before, event);
    if (after === before) return;
    workspaceState.value = after;
    if (
      event.kind === 'select' ||
      (event.kind === 'close' && before.selectedId !== after.selectedId)
    ) {
      const file = after.files.find((item) => item.artifactId === after.selectedId);
      artifactPreviewStack.value = file
        ? [
            {
              kind: 'artifact',
              artifactId: file.artifactId,
            },
          ]
        : [];
    }
  });
}

/** @public */
export const artifactPreviewWorkspace = {
  state: workspaceState,
  select: (artifactId: string | null) => navigateWorkspace({ kind: 'select', artifactId }),
  close: (artifactId: string) => navigateWorkspace({ kind: 'close', artifactId }),
  update: (file: PreviewWorkspaceFile) => navigateWorkspace({ kind: 'update', file }),
};

let opener: HTMLElement | null = null;

export function openArtifactPreview(target: ArtifactPreviewTarget, title?: string) {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  writePreviewStack([target], title);
}

export function takeArtifactPreviewOpener() {
  const element = opener;
  opener = null;
  return element;
}

export function pushArtifactPreview(target: ArtifactPreviewTarget) {
  writePreviewStack([...artifactPreviewStack.value, target]);
}

export function replaceArtifactPreview(target: ArtifactPreviewTarget) {
  writePreviewStack([...artifactPreviewStack.value.slice(0, -1), target]);
}

export function backArtifactPreview() {
  writePreviewStack(artifactPreviewStack.value.slice(0, -1));
}

export function closeArtifactPreview() {
  writePreviewStack([]);
}
