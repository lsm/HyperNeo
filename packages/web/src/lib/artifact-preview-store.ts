import { signal } from '@preact/signals';

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

let opener: HTMLElement | null = null;

export function openArtifactPreview(target: ArtifactPreviewTarget) {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  artifactPreviewStack.value = [target];
}

export function takeArtifactPreviewOpener() {
  const element = opener;
  opener = null;
  return element;
}

export function pushArtifactPreview(target: ArtifactPreviewTarget) {
  artifactPreviewStack.value = [...artifactPreviewStack.value, target];
}

export function replaceArtifactPreview(target: ArtifactPreviewTarget) {
  artifactPreviewStack.value = [...artifactPreviewStack.value.slice(0, -1), target];
}

export function backArtifactPreview() {
  artifactPreviewStack.value = artifactPreviewStack.value.slice(0, -1);
}

export function closeArtifactPreview() {
  artifactPreviewStack.value = [];
}
