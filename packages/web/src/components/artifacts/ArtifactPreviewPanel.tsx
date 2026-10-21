import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { t } from '../../lib/i18n/index.ts';
import {
  artifactPreviewStack,
  backArtifactPreview,
  pushArtifactPreview,
  replaceArtifactPreview,
  takeArtifactPreviewOpener,
  type ArtifactPreviewTarget,
} from '../../lib/artifact-preview-store.ts';
import {
  resolveArtifactReference,
  type ArtifactResolution,
} from '../../lib/artifact-reference-client.ts';
import { ArtifactPreview, artifactStateMessage, PreviewHeader } from './ArtifactPreview.tsx';
import { ArtifactPrSummary } from './ArtifactPrSummary.tsx';

type Reference = Extract<ArtifactPreviewTarget, { kind: 'reference' }>;

function ReferenceView({
  target,
  resolved,
}: {
  target: Reference;
  resolved: Map<string, ArtifactResolution>;
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
    return <ArtifactPreview artifactId={resolution.artifactId} onBack={backArtifactPreview} />;
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

export function ArtifactPreviewPanel() {
  const stack = artifactPreviewStack.value;
  const top = stack.at(-1);
  const open = !!top;
  const dialog = useRef<HTMLDivElement>(null);
  const resolved = useRef(new Map<string, ArtifactResolution>());

  useLayoutEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog.current?.contains(event.target as Node))
        backArtifactPreview();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      resolved.current.clear();
      takeArtifactPreviewOpener()?.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    dialog.current?.focus({ preventScroll: true });
  }, [stack[0]]);

  if (!top) return null;
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-labelledby="artifact-preview-title"
      tabIndex={-1}
      class="fixed inset-0 z-50 flex flex-col bg-surface focus:outline-none md:left-auto md:w-[min(40rem,55vw)] md:border-l md:border-line md:shadow-xl"
    >
      {top.kind === 'artifact' ? (
        <ArtifactPreview
          key={stack.length}
          artifactId={top.artifactId}
          onBack={backArtifactPreview}
        />
      ) : (
        <ReferenceView key={stack.length} target={top} resolved={resolved.current} />
      )}
    </div>
  );
}
