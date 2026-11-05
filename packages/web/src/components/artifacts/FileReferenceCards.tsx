import {
  previewLinkedReferenceCandidates,
  type PreviewReferenceCandidate,
} from '@hyperneo/shared/types/artifact-reference';
import { useMemo } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type ArtifactPreviewSource,
  openArtifactPreview,
} from '../../lib/artifact-preview-store.ts';
import { t } from '../../lib/i18n/index.ts';
import { systemState } from '../../lib/state.ts';
import { ownerPathLabel } from '../../lib/owner-path-label.ts';

const fileReferences = (superpipe({})('public-file-reference-cards') as PipelineAPI)
  .input(['texts'])
  .pipe(
    (texts: readonly string[]) => {
      const candidates = [
        ...new Map(
          texts.flatMap(previewLinkedReferenceCandidates).map((item) => [item.reference, item])
        ).values(),
      ];
      return candidates.length <= 256 ? candidates : [];
    },
    'texts',
    'candidates'
  )
  .pipe(
    (candidates: PreviewReferenceCandidate[]) => candidates.filter((item) => item.kind === 'local'),
    'candidates',
    'files'
  )
  .end('files') as (
  texts: readonly string[]
) => Extract<PreviewReferenceCandidate, { kind: 'local' }>[];

export function FileReferenceCards({
  text,
  details,
  source,
  ownerHome,
}: {
  text: string;
  details?: string;
  source: ArtifactPreviewSource;
  ownerHome?: string | null;
}) {
  const home = ownerHome === undefined ? systemState.value?.homeDirectory : ownerHome;
  const files = useMemo(
    () => fileReferences(details && details !== text ? [text, details] : [text]),
    [text, details]
  );
  if (!files.length) return null;
  return (
    <ul aria-label={t('artifact.fileReferences')} class="mt-3 flex flex-col items-start gap-1.5">
      {files.map(({ reference, path }) => {
        const title = path.split('/').at(-1) || reference;
        const label = ownerPathLabel(path, home);
        return (
          <li key={reference} class="max-w-full">
            <button
              type="button"
              title={label === path ? reference : label}
              aria-label={t('artifact.openCurrentNamed', { name: title })}
              onClick={() => openArtifactPreview({ kind: 'reference', source, reference }, title)}
              class="max-w-full break-words rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-fill-soft"
            >
              {title}
              {' · '}
              <span class="text-fg-muted">{t('artifact.currentFile')}</span>
              {' · '}
              <span class="text-accent">{t('artifact.openPreview')}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
