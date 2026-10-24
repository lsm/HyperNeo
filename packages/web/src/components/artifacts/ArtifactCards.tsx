import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import { t } from '../../lib/i18n/index.ts';
import { openArtifactPreview } from '../../lib/artifact-preview-store.ts';
import { formatBytes, KIND_LABELS } from './ArtifactPreview.tsx';

export function ArtifactCards({ artifacts }: { artifacts?: readonly ArtifactRef[] }) {
  if (!artifacts?.length) return null;
  return (
    <ul aria-label={t('artifact.attached')} class="mt-3 flex flex-col items-start gap-1.5">
      {artifacts.map((artifact) => (
        <li key={artifact.artifactId} class="max-w-full">
          <button
            type="button"
            aria-label={t('artifact.openNamed', { name: artifact.title })}
            onClick={() =>
              openArtifactPreview(
                { kind: 'artifact', artifactId: artifact.artifactId },
                artifact.title
              )
            }
            class="max-w-full break-words rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-fill-soft"
          >
            {`${artifact.title} · ${KIND_LABELS[artifact.kind]} · ${formatBytes(artifact.byteLength)} · `}
            <span class="text-accent">{t('artifact.openPreview')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
