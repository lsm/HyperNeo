import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  backArtifactPreview,
  pushArtifactPreview,
  replaceArtifactPreview,
  type ArtifactPreviewTarget,
} from '../../lib/artifact-preview-store.ts';
import {
  resolveArtifactReference,
  type ArtifactResolution,
} from '../../lib/artifact-reference-client.ts';
import { ArtifactPreview, artifactStateMessage, PreviewHeader } from './ArtifactPreview.tsx';
import { ArtifactPrSummary } from './ArtifactPrSummary.tsx';

type Reference = Extract<ArtifactPreviewTarget, { kind: 'reference' }>;

export function ReferenceView({
  target,
  resolved,
  markdownClass,
}: {
  target: Reference;
  resolved: Map<string, ArtifactResolution>;
  markdownClass?: string;
}) {
  const key = JSON.stringify(target);
  const [resolution, setResolution] = useState(() => resolved.get(key));
  useEffect(() => {
    const cached = resolved.get(key);
    setResolution(cached);
    if (cached) return;
    let current = true;
    connectionManager
      .getHub()
      .then((hub) => resolveArtifactReference(hub, target))
      .catch((): ArtifactResolution => ({ kind: 'state', state: 'daemon_unavailable' }))
      .then((next) => {
        if (next.kind !== 'state') resolved.set(key, next);
        if (current) setResolution(next);
      });
    return () => {
      current = false;
    };
  }, [key]);

  if (resolution?.kind === 'artifact')
    return (
      <ArtifactPreview
        artifactId={resolution.artifactId}
        onBack={backArtifactPreview}
        markdownClass={markdownClass}
      />
    );
  if (resolution?.kind === 'pr')
    return (
      <ArtifactPrSummary
        pr={resolution.pr}
        onBack={backArtifactPreview}
        onOpenFile={(path) =>
          pushArtifactPreview({ ...target, file: { path, headSha: resolution.pr.headSha } })
        }
      />
    );
  return (
    <section class="flex h-full min-h-0 flex-col bg-surface text-fg">
      <PreviewHeader title={t('artifact.untitled')} onBack={backArtifactPreview} />
      <div class="px-4 py-4 text-sm text-fg-muted">
        {resolution?.kind === 'choices' ? (
          <>
            <p>{t('artifact.choose')}</p>
            <ul class="mt-2 space-y-1">
              {resolution.choices.map((context) => (
                <li key={`${context.kind}:${context.id}`}>
                  <button
                    type="button"
                    onClick={() => replaceArtifactPreview({ ...target, context })}
                    class="rounded-md px-2 py-1 text-fg hover:bg-fill-soft"
                  >
                    {t(context.kind === 'todo' ? 'artifact.choiceTodo' : 'artifact.choiceAsk', {
                      id: context.id,
                    })}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p role="status">{artifactStateMessage(resolution?.state ?? 'loading')}</p>
        )}
      </div>
    </section>
  );
}
