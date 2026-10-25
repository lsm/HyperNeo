import {
  ARTIFACT_DEFAULT_LIMITS,
  type ArtifactFileMetadata,
} from '@hyperneo/shared/types/artifact-file';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  type ArtifactPreviewState,
  readArtifactPreview,
} from '../../lib/artifact-preview-client.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { t } from '../../lib/i18n/index.ts';
import { copyToClipboard } from '../../lib/utils.ts';
import { connectionState } from '../../lib/state.ts';
import MarkdownRenderer, { clearArtifactRenderCache } from '../chat/MarkdownRenderer.tsx';
import { ArtifactDownload } from './ArtifactDownload.tsx';
import { ArtifactHtmlDocument } from './ArtifactHtmlDocument.tsx';
import { ArtifactHtmlSource } from './ArtifactHtmlSource.tsx';
import { ArtifactImage } from './ArtifactImage.tsx';

type Shown = ArtifactPreviewState | { state: 'loading' };

export const KIND_LABELS = {
  markdown: 'Markdown',
  html: 'HTML',
  image: 'Image',
  json: 'JSON',
  log: 'Log',
  text: 'Text',
};

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Number((bytes / 1024).toFixed(1))} KB`
      : `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;

export function artifactStateMessage(state: Exclude<Shown['state'], 'ready'>) {
  if (state === 'limit')
    return t('artifact.limit', {
      limit: formatBytes(ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes),
    });
  return t(
    (
      {
        loading: 'artifact.loading',
        daemon_unavailable: 'artifact.daemonUnavailable',
        needs_update: 'artifact.needsUpdate',
        revoked: 'artifact.revoked',
        forbidden: 'artifact.forbidden',
        unsupported: 'artifact.unsupported',
        html_source: 'artifact.htmlSourceOnly',
      } as const
    )[state]
  );
}

function revisionLabel({ revision, sha256 }: ArtifactFileMetadata) {
  if (revision?.kind === 'commit')
    return t('artifact.commit', { sha: revision.commitSha.slice(0, 7) });
  const hash = sha256.slice(0, 8);
  return revision?.kind === 'worktree'
    ? t('artifact.worktreeSnapshot', { hash })
    : t('artifact.snapshot', { hash });
}

export function PreviewHeader({
  title,
  facts,
  onBack,
  children,
  titleId = 'artifact-preview-title',
}: {
  title?: string;
  facts?: string;
  onBack?: () => void;
  children?: ComponentChildren;
  titleId?: string;
}) {
  return (
    <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
      {onBack && (
        <button
          type="button"
          aria-label={t('artifact.back')}
          onClick={onBack}
          class="rounded-md px-2 py-1 text-fg-soft hover:bg-surface-raised hover:text-fg"
        >
          ←
        </button>
      )}
      <div class="min-w-0 flex-1 basis-56">
        {title && (
          <h1 id={titleId} class="truncate text-sm font-medium" title={title}>
            {title}
          </h1>
        )}
        {facts && <p class="truncate text-xs text-fg-muted">{facts}</p>}
      </div>
      {children}
    </header>
  );
}

export function ArtifactPreview({
  artifactId,
  onBack,
  markdownClass,
  titleId,
  onMetadata,
  presentation = 'full',
}: {
  artifactId: string;
  onBack: () => void;
  markdownClass?: string;
  titleId?: string;
  onMetadata?: (metadata: ArtifactFileMetadata) => void;
  presentation?: 'full' | 'result' | 'tabbed';
}) {
  const connection = connectionState.value;
  const connected = connection === 'connected';
  const lost = ['disconnected', 'error', 'failed'].includes(connection);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const full = presentation === 'full';
  const mode = full ? view : 'preview';

  useEffect(() => {
    setPendingUrl(null);
    setView('preview');
    if (!connected) {
      clearArtifactRenderCache();
      setShown((previous) =>
        lost || previous.state === 'daemon_unavailable'
          ? { state: 'daemon_unavailable' }
          : { state: 'loading' }
      );
      if (!lost) connectionManager.getHub().catch(() => undefined);
      return;
    }
    setShown({ state: 'loading' });
    let current = true;
    connectionManager
      .getHub()
      .then((hub) => readArtifactPreview(hub, artifactId))
      .catch((): ArtifactPreviewState => ({ state: 'daemon_unavailable' }))
      .then((next) => current && setShown(next));
    return () => {
      current = false;
    };
  }, [artifactId, connected, lost]);

  const metadata = 'metadata' in shown ? shown.metadata : null;
  useEffect(() => {
    if (metadata) onMetadata?.(metadata);
  }, [metadata, onMetadata]);
  const activateLink = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    const url = target?.closest('[data-external-href]')?.getAttribute('data-external-href');
    if (!url || (event instanceof KeyboardEvent && event.key !== 'Enter')) return;
    event.preventDefault();
    setPendingUrl(url);
  };
  const toggle = (value: 'preview' | 'source', label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => setView(value)}
      class={`rounded-md px-3 py-1 text-sm ${view === value ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'}`}
    >
      {label}
    </button>
  );

  return (
    <section
      class="flex h-full min-h-0 flex-col bg-surface text-fg"
      aria-label={t('artifact.region')}
    >
      <PreviewHeader
        titleId={titleId}
        title={
          presentation === 'tabbed'
            ? undefined
            : (metadata?.artifact.title ?? t('artifact.untitled'))
        }
        facts={
          metadata
            ? `${KIND_LABELS[metadata.artifact.kind]} · ${formatBytes(metadata.artifact.byteLength)} · ${revisionLabel(metadata)}`
            : undefined
        }
        onBack={full ? onBack : undefined}
      >
        {full && ((shown.state === 'ready' && !shown.image) || shown.state === 'html_source') && (
          <div class="flex gap-1">
            {toggle('preview', t('artifact.preview'))}
            {toggle('source', t('artifact.source'))}
          </div>
        )}
        {full && metadata && (
          <ArtifactDownload
            key={artifactId}
            metadata={metadata}
            onUnavailable={() => setShown({ state: 'revoked' })}
          />
        )}
      </PreviewHeader>
      <div
        class="min-h-0 flex-1 overflow-auto px-4 py-4"
        onClick={activateLink}
        onKeyDown={activateLink}
      >
        {shown.state === 'html_source' && mode === 'source' ? (
          <ArtifactHtmlSource metadata={shown.metadata} onUnavailable={setShown} />
        ) : shown.state !== 'ready' ? (
          <p class="text-sm text-fg-muted" role="status">
            {shown.state === 'limit' && metadata?.artifact.kind === 'image'
              ? t('artifact.imageLimit')
              : !full && shown.state === 'html_source'
                ? t('artifact.htmlPreviewUnavailable')
                : artifactStateMessage(shown.state)}
          </p>
        ) : shown.html ? (
          mode === 'preview' ? (
            <ArtifactHtmlDocument html={shown.html} />
          ) : (
            <ArtifactHtmlSource metadata={shown.metadata} onUnavailable={setShown} />
          )
        ) : shown.image ? (
          <ArtifactImage blob={shown.image} title={shown.metadata.artifact.title} />
        ) : mode === 'preview' && shown.metadata.artifact.kind === 'markdown' ? (
          <MarkdownRenderer content={shown.text} artifactLinks class={markdownClass} />
        ) : (
          <>
            {!!shown.omittedBytes && (
              <p role="status" class="mb-3 text-sm text-fg-muted">
                {t('artifact.omitted', { count: shown.omittedBytes })}
              </p>
            )}
            <button
              type="button"
              class="mb-3 rounded-md bg-surface-raised px-3 py-1 text-sm"
              onClick={() =>
                copyToClipboard(mode === 'source' ? (shown.sourceText ?? shown.text) : shown.text)
              }
            >
              {t('artifact.copyVisible')}
            </button>
            <pre class="whitespace-pre-wrap break-words font-mono text-sm select-text">
              {mode === 'source' ? (shown.sourceText ?? shown.text) : shown.text}
            </pre>
          </>
        )}
      </div>
      {pendingUrl && (
        <div class="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm">
          <span class="basis-full text-fg-muted">{t('artifact.linkPrompt')}</span>
          <code class="min-w-0 flex-1 basis-full break-all">{pendingUrl}</code>
          <button
            type="button"
            class="rounded-md bg-surface-raised px-3 py-1 hover:bg-fill-strong"
            onClick={() => {
              window.open(pendingUrl, '_blank', 'noopener,noreferrer');
              setPendingUrl(null);
            }}
          >
            {t('artifact.openLink')}
          </button>
          <button
            type="button"
            class="rounded-md px-3 py-1 text-fg-muted hover:text-fg"
            onClick={() => setPendingUrl(null)}
          >
            {t('artifact.cancel')}
          </button>
        </div>
      )}
    </section>
  );
}
