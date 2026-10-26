import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  artifactPreviewStack,
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
  promoteFiles = false,
  suspended = false,
  tabbed = false,
}: {
  target: Reference;
  resolved: Map<string, ArtifactResolution>;
  markdownClass?: string;
  promoteFiles?: boolean;
  suspended?: boolean;
  tabbed?: boolean;
}) {
  const key = JSON.stringify(target);
  const [settled, setSettled] = useState(() => ({ key, value: resolved.get(key) }));
  const resolution = settled.key === key ? settled.value : resolved.get(key);
  const promote = promoteFiles && !target.file;
  useEffect(() => {
    const cached = resolved.get(key);
    setSettled({ key, value: cached });
    if (cached) return;
    let current = true;
    connectionManager
      .getHub()
      .then((hub) => resolveArtifactReference(hub, target))
      .catch((): ArtifactResolution => ({ kind: 'state', state: 'daemon_unavailable' }))
      .then((next) => {
        if (!current || JSON.stringify(artifactPreviewStack.peek().at(-1)) !== key) return;
        if (next.kind !== 'state') resolved.set(key, next);
        setSettled({ key, value: next });
      });
    return () => {
      current = false;
    };
  }, [key]);
  useEffect(() => {
    if (
      promote &&
      !suspended &&
      resolution?.kind === 'artifact' &&
      artifactPreviewStack.peek().at(-1) === target
    )
      replaceArtifactPreview({ kind: 'artifact', artifactId: resolution.artifactId });
  }, [promote, suspended, resolution, target]);

  if (promote && resolution?.kind === 'artifact') return null;
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
      {(!tabbed || target.file) && (
        <PreviewHeader title={t('artifact.untitled')} onBack={backArtifactPreview} />
      )}
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
