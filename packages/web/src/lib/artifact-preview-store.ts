import { signal } from '@preact/signals';

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

export function openArtifactPreview(target: ArtifactPreviewTarget) {
  artifactPreviewStack.value = [target];
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
