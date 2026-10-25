import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { loadArtifactMetadata } from '../lib/artifact-preview-client.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { connectionState } from '../lib/state.ts';
import {
  type NeoDraftReloadEntry,
  type createNeoDraftReloadBuffer,
  neoDraftRecoveryInput,
} from './neo-draft-reload-buffer.ts';

type Buffer = ReturnType<typeof createNeoDraftReloadBuffer>;
type Recovery = { ok: true } | { ok: false; reason: string };
export type NeoDraftRecoverySettlement = 'restore' | 'forget' | 'keep';

export function admitNeoDraftRecovery(
  result: unknown
): { value: Recovery } | { reason: NeoDraftRecoverySettlement } {
  if (!result || typeof result !== 'object' || !('ok' in result)) return { reason: 'keep' };
  if (result.ok === true) return { value: { ok: true } };
  const reason = 'reason' in result ? result.reason : null;
  return reason === 'superseded' || reason === 'submitted'
    ? { reason: 'forget' }
    : { reason: 'keep' };
}

export function requireUntouchedComposer(
  entry: NeoDraftReloadEntry,
  visible: string
): NeoDraftRecoverySettlement {
  const shown = visible.trim();
  return shown === '' || shown === (entry.base ?? '').trim() || shown === entry.text.trim()
    ? 'restore'
    : 'keep';
}

export const settleNeoDraftRecovery = (superpipe({})('neo-draft-reload-recovery') as PipelineAPI)
  .input(['result', 'entry', 'visible'])
  .pipe(admitNeoDraftRecovery, 'result', 'result:settlement')
  .pipe(requireUntouchedComposer, ['entry', 'visible'], 'settlement')
  .end('settlement') as (
  result: unknown,
  entry: NeoDraftReloadEntry,
  visible: string
) => NeoDraftRecoverySettlement;

export function useNeoDraftReloadRecovery(
  sessionId: string | null,
  buffer: Buffer,
  readDraft: () => string,
  writeDraft: (text: string, reference?: NeoDraftReloadEntry['previewContext']) => void,
  readVersion: () => unknown = () => undefined
): boolean {
  const readRef = useRef(readDraft);
  readRef.current = readDraft;
  const writeRef = useRef(writeDraft);
  writeRef.current = writeDraft;
  const versionRef = useRef(readVersion);
  versionRef.current = readVersion;
  const captures = useRef(new Map<string, { id: string; version: unknown }>());
  const connected = connectionState.value === 'connected';
  const key = JSON.stringify([sessionId, connected]);
  const generation = useRef({ key, ticket: 0 });
  if (generation.current.key !== key)
    generation.current = { key, ticket: generation.current.ticket + 1 };
  const ticket = generation.current.ticket;
  const [settled, setSettled] = useState(() => (sessionId && buffer.read(sessionId) ? -1 : ticket));

  useLayoutEffect(() => {
    const entry = sessionId ? buffer.read(sessionId) : null;
    if (!entry) {
      setSettled(ticket);
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!sessionId || !connected || !hub) return;
    let active = true;
    if (captures.current.get(sessionId)?.id !== entry.id)
      captures.current.set(sessionId, { id: entry.id, version: versionRef.current() });
    const version = captures.current.get(sessionId)!.version;
    if (versionRef.current() !== version) return;
    const current = () =>
      active &&
      generation.current.ticket === ticket &&
      versionRef.current() === version &&
      buffer.read(sessionId)?.id === entry.id;
    void invokeOperation<unknown>(hub, 'neo.draft.recover', neoDraftRecoveryInput(entry))
      .then(async (result) => {
        if (!current()) return;
        const settlement = settleNeoDraftRecovery(result, entry, readRef.current());
        if (settlement === 'restore') {
          let reference = entry.previewContext;
          if (reference) {
            const metadata = await loadArtifactMetadata(hub, reference.artifactId);
            const available =
              'value' in metadata &&
              metadata.value?.artifact?.artifactId === reference.artifactId &&
              metadata.value?.sha256 === reference.snapshot;
            reference = { ...reference, state: available ? 'available' : 'unavailable' };
          }
          if (!current() || settleNeoDraftRecovery(result, entry, readRef.current()) !== 'restore')
            return;
          writeRef.current(entry.text, reference);
        } else if (settlement === 'forget') buffer.forget(sessionId, entry.id);
        setSettled(ticket);
      })
      .catch(() => {
        if (current()) setSettled(ticket);
      });
    return () => {
      active = false;
    };
  }, [sessionId, connected, ticket]);
  return !sessionId || !buffer.read(sessionId) || settled === ticket;
}
