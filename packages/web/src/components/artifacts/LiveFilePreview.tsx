import { useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { readLiveFile } from '../../lib/live-file-client.ts';
import {
  type ArtifactPreviewTarget,
  backArtifactPreview,
} from '../../lib/artifact-preview-store.ts';
import { connectionState } from '../../lib/state.ts';
import { t } from '../../lib/i18n/index.ts';
import MarkdownRenderer, { clearArtifactRenderCache } from '../chat/MarkdownRenderer.tsx';
import { ArtifactHtmlDocument } from './ArtifactHtmlDocument.tsx';
import { ArtifactVideo } from './ArtifactVideo.tsx';
import { ArtifactImage } from './ArtifactImage.tsx';
import {
  artifactStateMessage,
  formatBytes,
  KIND_LABELS,
  PreviewHeader,
} from './ArtifactPreview.tsx';

type Reference = Extract<ArtifactPreviewTarget, { kind: 'reference' }>;
type File = Awaited<ReturnType<typeof readLiveFile>>;
const refusal = (reason: string) => {
  if (reason === 'missing') return t('artifact.missing');
  if (reason === 'size_limit') return t('artifact.liveLimit');
  if (reason === 'safe_open_unavailable') return t('artifact.safeOpenUnavailable');
  if (reason === 'METHOD_NOT_FOUND') return artifactStateMessage('needs_update');
  if (reason === 'file_changed' || reason === 'invalid_offset') return t('artifact.fileChanged');
  return artifactStateMessage(
    reason === 'forbidden'
      ? 'forbidden'
      : reason === 'unsupported_type'
        ? 'unsupported'
        : 'daemon_unavailable'
  );
};

export function LiveFilePreview({
  target,
  markdownClass,
  tabbed = false,
  onAskFile,
}: {
  target: Reference;
  markdownClass?: string;
  tabbed?: boolean;
  onAskFile?: (path: string) => void;
}) {
  const connected = connectionState.value === 'connected';
  const active = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ target: Reference; file?: File; error?: string }>();
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const title = target.reference.split(/[\\/]/).at(-1) || target.reference;
  const shown = connected && result?.target === target ? result : undefined;
  const file = shown?.file;
  const load = async (download = false) => {
    const controller = active.current;
    if (!controller) return;
    if (download) {
      setDownloading(true);
      setDownloadFailed(false);
    }
    try {
      const hub = await connectionManager.getHub();
      const next = await readLiveFile(hub, target, controller.signal);
      controller.signal.throwIfAborted();
      if (!download || file?.kind !== 'video') setResult({ target, file: next });
      if (download) {
        const url = URL.createObjectURL(next.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = title;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = (error as { code?: string }).code ?? (error as Error).message;
        if (
          download &&
          file?.kind === 'video' &&
          !['forbidden', 'FORBIDDEN', 'UNAUTHORIZED', 'missing', 'safe_open_unavailable'].includes(
            reason
          )
        )
          setDownloadFailed(true);
        else setResult({ target, error: reason });
      }
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  };
  useEffect(() => {
    setResult(undefined);
    setPendingUrl(null);
    setDownloading(false);
    setDownloadFailed(false);
    if (!connected) return;
    const controller = new AbortController();
    active.current = controller;
    void load();
    return () => {
      controller.abort();
      active.current = null;
      clearArtifactRenderCache();
    };
  }, [target, connected]);
  return (
    <section
      class="flex h-full min-h-0 flex-col bg-surface text-fg"
      aria-label={t('artifact.region')}
    >
      <PreviewHeader
        title={tabbed ? undefined : title}
        facts={file ? `${KIND_LABELS[file.kind]} · ${formatBytes(file.blob.size)}` : undefined}
        onBack={tabbed ? undefined : backArtifactPreview}
      >
        {file?.path && onAskFile && (
          <button
            type="button"
            class="rounded-md bg-surface-raised px-3 py-1 text-sm"
            onClick={() => onAskFile(file.path!)}
          >
            {t('artifact.askNeo')}
          </button>
        )}
        {file && downloadFailed && (
          <p role="status" class="text-xs text-fg-muted">
            {t('artifact.downloadFailed')}
          </p>
        )}
        {file && (
          <button
            type="button"
            disabled={downloading}
            class="rounded-md bg-surface-raised px-3 py-1 text-sm"
            onClick={() => void load(true)}
          >
            {t(
              downloading
                ? 'artifact.loading'
                : file.kind === 'html'
                  ? 'artifact.downloadSafeHtml'
                  : 'artifact.download'
            )}
          </button>
        )}
      </PreviewHeader>
      <div
        class="min-h-0 flex-1 overflow-auto px-4 py-4"
        onClick={(event) => {
          const element = event.target instanceof Element ? event.target : null;
          const url = element?.closest('[data-external-href]')?.getAttribute('data-external-href');
          if (url) {
            event.preventDefault();
            setPendingUrl(url);
          }
        }}
      >
        {!file ? (
          <p role="status" class="text-sm text-fg-muted">
            {shown?.error
              ? refusal(shown.error)
              : artifactStateMessage(connected ? 'loading' : 'daemon_unavailable')}
          </p>
        ) : file.kind === 'video' ? (
          <ArtifactVideo blob={file.blob} title={title} />
        ) : file.kind === 'image' ? (
          <ArtifactImage blob={file.blob} title={title} />
        ) : file.kind === 'html' ? (
          <ArtifactHtmlDocument html={file.html} />
        ) : file.kind === 'markdown' ? (
          <MarkdownRenderer content={file.text} artifactLinks class={markdownClass} />
        ) : (
          <pre class="whitespace-pre-wrap break-words font-mono text-sm select-text">
            {file.text}
          </pre>
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
