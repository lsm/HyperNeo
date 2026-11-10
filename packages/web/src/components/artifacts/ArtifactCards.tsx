import type { ArtifactRef, PublicHandoffReference } from '@hyperneo/shared/types/artifact-file';
import { t } from '../../lib/i18n/index.ts';
import { openArtifactPreview } from '../../lib/artifact-preview-store.ts';
import { formatBytes, KIND_LABELS } from './ArtifactPreview.tsx';

export function ArtifactCards({
  artifacts,
  source,
}: {
  artifacts?: readonly (ArtifactRef | PublicHandoffReference)[];
  source?: { kind: 'question' | 'publication'; id: string };
}) {
  if (!artifacts?.length) return null;
  return (
    <ul aria-label={t('artifact.attached')} class="mt-3 flex flex-col items-start gap-1.5">
      {artifacts.map((artifact) =>
        'type' in artifact ? (
          <li key={JSON.stringify(artifact)} class="max-w-full">
            <button
              type="button"
              disabled={!source}
              aria-label={t('artifact.openNamed', { name: artifact.name })}
              onClick={() =>
                source &&
                openArtifactPreview(
                  { kind: 'reference', source, reference: artifact.name, handoff: artifact },
                  artifact.name
                )
              }
              class="max-w-full break-words rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-fill-soft disabled:opacity-60"
            >
              <span class="text-fg-muted">{t('artifact.workerFile')}</span>
              {' · '}
              {`${artifact.name} · ${formatBytes(artifact.byteLength)} · `}
              <span class="text-accent">
                {source ? t('artifact.openPreview') : t('artifact.forbidden')}
              </span>
            </button>
          </li>
        ) : (
          <li key={artifact.artifactId} class="max-w-full">
            <button
              type="button"
              aria-label={t('artifact.openNamed', { name: artifact.title })}
              aria-description={t('artifact.savedAttachment')}
              onClick={() =>
                openArtifactPreview(
                  { kind: 'artifact', artifactId: artifact.artifactId },
                  artifact.title
                )
              }
              class="max-w-full break-words rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-fill-soft"
            >
              <span class="text-fg-muted">{t('artifact.savedAttachment')}</span>
              {' · '}
              {`${artifact.title} · ${KIND_LABELS[artifact.kind]} · ${formatBytes(artifact.byteLength)} · `}
              <span class="text-accent">{t('artifact.openPreview')}</span>
            </button>
          </li>
        )
      )}
    </ul>
  );
}
