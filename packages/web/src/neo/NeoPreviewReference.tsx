import type { NeoPreviewReference as Reference } from '@hyperneo/shared/types/neo-preview-context';
import { openArtifactPreview } from '../lib/artifact-preview-store.ts';
import { t } from '../lib/i18n/index.ts';

export function NeoPreviewReference({ reference }: { reference?: Reference }) {
  if (!reference) return null;
  return (
    <button
      type="button"
      disabled={reference.state !== 'available'}
      class="mb-2 block max-w-full break-words text-left text-xs text-fg-muted enabled:hover:text-accent disabled:opacity-70"
      onClick={() =>
        openArtifactPreview(
          { kind: 'artifact', artifactId: reference.artifactId },
          reference.displayName
        )
      }
    >
      {t(reference.state === 'available' ? 'chat.previewReference' : 'chat.previewUnavailable', {
        file: reference.displayName,
        snapshot: reference.snapshot.slice(0, 8),
      })}
    </button>
  );
}
