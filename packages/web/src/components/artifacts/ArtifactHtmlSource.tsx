import { t } from '../../lib/i18n/index.ts';
import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import {
  readArtifactSource,
  type ArtifactPreviewState,
} from '../../lib/artifact-preview-client.ts';

export function ArtifactHtmlSource({
  metadata,
  onUnavailable,
}: {
  metadata: ArtifactFileMetadata;
  onUnavailable: (state: ArtifactPreviewState) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setText(null);
    connectionManager
      .getHub()
      .then((hub) => readArtifactSource(hub, metadata))
      .catch((): ArtifactPreviewState => ({ state: 'daemon_unavailable' }))
      .then((result) => {
        if (!current) return;
        if (result.state === 'ready') setText(result.text);
        else onUnavailable(result);
      });
    return () => {
      current = false;
    };
  }, [metadata, onUnavailable]);
  return text === null ? (
    <p role="status" class="text-sm text-fg-muted">
      {t('artifact.loadingSource')}
    </p>
  ) : (
    <pre class="whitespace-pre-wrap break-words font-mono text-sm select-text">{text}</pre>
  );
}
