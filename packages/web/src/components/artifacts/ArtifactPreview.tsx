import { useEffect, useState } from 'preact/hooks';
import {
  ARTIFACT_DEFAULT_LIMITS,
  type ArtifactFileMetadata,
} from '@hyperneo/shared/types/artifact-file';
import { connectionManager } from '../../lib/connection-manager.ts';
import { connectionState } from '../../lib/state.ts';
import {
  readArtifactPreview,
  type ArtifactPreviewState,
} from '../../lib/artifact-preview-client.ts';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';

type Shown = ArtifactPreviewState | { state: 'loading' };

const KIND_LABELS = {
  markdown: 'Markdown',
  html: 'HTML',
  image: 'Image',
  json: 'JSON',
  log: 'Log',
  text: 'Text',
};

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Number((bytes / 1024).toFixed(1))} KB`
      : `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;

const MESSAGES = {
  loading: 'Loading preview…',
  daemon_unavailable: 'The daemon that owns this file is not reachable.',
  revoked: 'This file is no longer available to you.',
  forbidden: 'This reference points outside what the preview may open.',
  unsupported: 'This format has no preview yet.',
  limit: `This file is larger than the ${formatBytes(ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes)} preview limit.`,
};

function revisionLabel({ revision, sha256 }: ArtifactFileMetadata) {
  if (revision?.kind === 'commit') return `commit ${revision.commitSha.slice(0, 7)}`;
  const hash = sha256.slice(0, 8);
  return revision?.kind === 'worktree' ? `worktree snapshot ${hash}` : `snapshot ${hash}`;
}

export function ArtifactPreview({
  artifactId,
  onBack,
}: {
  artifactId: string;
  onBack: () => void;
}) {
  const lost = ['disconnected', 'error', 'failed'].includes(connectionState.value);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  useEffect(() => {
    setShown(lost ? { state: 'daemon_unavailable' } : { state: 'loading' });
    setPendingUrl(null);
    if (lost) return;
    let current = true;
    connectionManager
      .getHub()
      .then((hub) => readArtifactPreview(hub, artifactId))
      .catch((): ArtifactPreviewState => ({ state: 'daemon_unavailable' }))
      .then((next) => current && setShown(next));
    return () => {
      current = false;
    };
  }, [artifactId, lost]);

  const metadata = 'metadata' in shown ? shown.metadata : null;
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
    <section class="flex h-full min-h-0 flex-col bg-surface text-fg" aria-label="File preview">
      <header class="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          class="rounded-md px-2 py-1 text-fg-soft hover:bg-surface-raised hover:text-fg"
        >
          ←
        </button>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-medium" title={metadata?.artifact.title}>
            {metadata?.artifact.title ?? 'Preview'}
          </h1>
          {metadata && (
            <p class="truncate text-xs text-fg-muted">
              {`${KIND_LABELS[metadata.artifact.kind]} · ${formatBytes(metadata.artifact.byteLength)} · ${revisionLabel(metadata)}`}
            </p>
          )}
        </div>
        {shown.state === 'ready' && (
          <div class="flex gap-1">
            {toggle('preview', 'Preview')}
            {toggle('source', 'Source')}
          </div>
        )}
      </header>
      <div
        class="min-h-0 flex-1 overflow-auto px-4 py-4"
        onClick={activateLink}
        onKeyDown={activateLink}
      >
        {shown.state !== 'ready' ? (
          <p class="text-sm text-fg-muted" role="status">
            {MESSAGES[shown.state]}
          </p>
        ) : view === 'preview' ? (
          <MarkdownRenderer content={shown.text} artifactLinks />
        ) : (
          <pre class="whitespace-pre-wrap break-words font-mono text-sm select-text">
            {shown.text}
          </pre>
        )}
      </div>
      {pendingUrl && (
        <div class="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm">
          <span class="text-fg-muted">Open this link in a new tab?</span>
          <code class="min-w-0 flex-1 truncate">{pendingUrl}</code>
          <button
            type="button"
            class="rounded-md bg-surface-raised px-3 py-1 hover:bg-fill-strong"
            onClick={() => {
              window.open(pendingUrl, '_blank', 'noopener,noreferrer');
              setPendingUrl(null);
            }}
          >
            Open link
          </button>
          <button
            type="button"
            class="rounded-md px-3 py-1 text-fg-muted hover:text-fg"
            onClick={() => setPendingUrl(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
