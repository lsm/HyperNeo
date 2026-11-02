import {
  previewReferenceCandidates,
  type PreviewReferenceCandidate,
} from '@hyperneo/shared/types/artifact-reference';
import { useMemo } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type ArtifactPreviewSource,
  openArtifactPreview,
} from '../../lib/artifact-preview-store.ts';
import { t } from '../../lib/i18n/index.ts';

const fileReferences = (superpipe({})('public-file-reference-cards') as PipelineAPI)
  .input(['text'])
  .pipe(previewReferenceCandidates, 'text', 'candidates')
  .pipe(
    (candidates: PreviewReferenceCandidate[]) => candidates.filter((item) => item.kind === 'local'),
    'candidates',
    'files'
  )
  .end('files') as (text: string) => Extract<PreviewReferenceCandidate, { kind: 'local' }>[];

export function FileReferenceCards({
  text,
  source,
}: {
  text: string;
  source: ArtifactPreviewSource;
}) {
  const files = useMemo(() => fileReferences(text), [text]);
  if (!files.length) return null;
  return (
    <ul aria-label={t('artifact.fileReferences')} class="mt-3 flex flex-col items-start gap-1.5">
      {files.map(({ reference, path }) => {
        const title = path.split('/').at(-1) || reference;
        return (
          <li key={reference} class="max-w-full">
            <button
              type="button"
              title={reference}
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
