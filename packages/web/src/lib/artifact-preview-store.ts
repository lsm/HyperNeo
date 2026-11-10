import { batch, signal } from '@preact/signals';
import type { PublicHandoffReference } from '@hyperneo/shared/types/artifact-file';
import { isLiveReference } from './live-file-client.ts';
import {
  previewWorkspace,
  previewFileKey,
  type PreviewWorkspaceEvent,
  type PreviewWorkspaceFile,
} from './artifact-preview-workspace.ts';

/** @public */
export { previewWorkspace } from './artifact-preview-workspace.ts';

export type ArtifactPreviewSource = {
  kind: 'message' | 'publication' | 'todo' | 'question';
  id: string;
  revisionId?: string;
};

export type ArtifactPreviewContext = { kind: 'todo' | 'ask'; id: string };

export type ArtifactPreviewTarget =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'reference';
      source: ArtifactPreviewSource;
      reference: string;
      handoff?: PublicHandoffReference;
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
    } else if (top.kind === 'session') {
      const known = workspaceState.value.files.find((file) => file.sessionId === top.sessionId);
      workspaceState.value = previewWorkspace.step(workspaceState.value, {
        kind: 'open',
        file: { sessionId: top.sessionId, title: title ?? known?.title ?? '' },
      });
    } else if (isLiveReference(top)) {
      workspaceState.value = previewWorkspace.step(workspaceState.value, {
        kind: 'open',
        file: {
          reference: top,
          title: title ?? (top.reference.split(/[\\/]/).at(-1) || top.reference),
        },
      });
    }
  });
}

function fileTarget(file: PreviewWorkspaceFile): ArtifactPreviewTarget {
  if (file.reference) return file.reference;
  return file.sessionId !== undefined
    ? { kind: 'session', sessionId: file.sessionId }
    : { kind: 'artifact', artifactId: file.artifactId };
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
      const file = after.files.find((item) => previewFileKey(item) === after.selectedId);
      artifactPreviewStack.value = file ? [fileTarget(file)] : [];
    }
  });
}

/** @public */
export const artifactPreviewWorkspace = {
  state: workspaceState,
  select: (key: string | null) => navigateWorkspace({ kind: 'select', key }),
  close: (key: string) => navigateWorkspace({ kind: 'close', key }),
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
