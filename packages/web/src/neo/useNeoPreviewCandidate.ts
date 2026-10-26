import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { loadArtifactMetadata } from '../lib/artifact-preview-client.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { readNeoPreviewReference } from './neo-preview-context.ts';

export function useNeoPreviewCandidate(scope: string | null, artifactId?: string) {
  const connected = connectionState.value === 'connected';
  const key = JSON.stringify([scope, artifactId, connected]);
  const generation = useRef({ key, ticket: 0 });
  if (generation.current.key !== key)
    generation.current = { key, ticket: generation.current.ticket + 1 };
  const ticket = generation.current.ticket;
  const [loaded, setLoaded] = useState<{ ticket: number; reference: NeoPreviewReference } | null>(
    null
  );
  useLayoutEffect(() => {
    if (!scope || !artifactId || !connected) return;
    let active = true;
    void connectionManager
      .getHub()
      .then((hub) => loadArtifactMetadata(hub, artifactId))
      .then((result) => {
        if (!active || generation.current.ticket !== ticket || !('value' in result)) return;
        const metadata = result.value;
        const reference = readNeoPreviewReference({
          artifactId: metadata.artifact.artifactId,
          snapshot: metadata.sha256,
          displayName: metadata.artifact.title,
          state: 'available',
        });
        if (reference?.artifactId === artifactId) setLoaded({ ticket, reference });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [scope, artifactId, connected, ticket]);
  return connected && loaded?.ticket === ticket ? loaded.reference : undefined;
}
