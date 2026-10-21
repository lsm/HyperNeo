import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { useEffect, useRef, useState } from 'preact/hooks';
import { downloadArtifact } from '../../lib/artifact-media-client.ts';
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
  const start = async () => {
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
    } catch {
      if (!controller.signal.aborted) onUnavailable();
    } finally {
      if (active.current === controller) {
        active.current = null;
        setProgress(null);
      }
    }
  };
  return progress === null ? (
    <button type="button" class="rounded-md bg-surface-raised px-3 py-1 text-sm" onClick={start}>
      {t('artifact.download')}
    </button>
  ) : (
    <button
      type="button"
      class="rounded-md bg-surface-raised px-3 py-1 text-sm"
      onClick={() => active.current?.abort()}
    >
      {t('artifact.cancel')} ({progress} / {metadata.artifact.byteLength} B)
    </button>
  );
}
