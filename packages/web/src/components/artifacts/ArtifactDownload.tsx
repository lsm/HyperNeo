import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArtifactReadRefusal, downloadArtifact } from '../../lib/artifact-media-client.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { t } from '../../lib/i18n/index.ts';

export function ArtifactDownload({
  metadata,
  onUnavailable,
}: {
  metadata: ArtifactFileMetadata;
  onUnavailable: () => void;
}) {
  const active = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [metadata]
  );
  const [failed, setFailed] = useState(false);
  const start = async () => {
    setFailed(false);
    const controller = new AbortController();
    active.current = controller;
    setProgress(0);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    try {
      const hub = await connectionManager.getHub();
      await downloadArtifact(hub, metadata, controller.signal, async (part) => {
        parts.push(part);
        setProgress((value) => (value ?? 0) + part.length);
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = metadata.sourcePath.split('/').at(-1) || 'artifact';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ArtifactReadRefusal) onUnavailable();
        else setFailed(true);
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setProgress(null);
      }
    }
  };
  return (
    <div class="flex flex-wrap items-center gap-2">
      {failed && (
        <p role="status" class="text-xs text-fg-muted">
          {t('artifact.downloadFailed')}
        </p>
      )}
      {progress === null ? (
        <button
          type="button"
          class="rounded-md bg-surface-raised px-3 py-1 text-sm"
          onClick={start}
        >
          {t(failed ? 'artifact.retryDownload' : 'artifact.download')}
        </button>
      ) : (
        <button
          type="button"
          class="rounded-md bg-surface-raised px-3 py-1 text-sm"
          onClick={() => active.current?.abort()}
        >
          {t('artifact.cancel')} ({progress} / {metadata.artifact.byteLength} B)
        </button>
      )}
    </div>
  );
}
