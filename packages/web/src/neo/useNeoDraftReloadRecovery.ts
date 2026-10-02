import { useEffect, useRef } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { connectionState } from '../lib/state.ts';
import type { NeoDraftReloadEntry, createNeoDraftReloadBuffer } from './neo-draft-reload-buffer.ts';

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
  writeDraft: (text: string) => void
): void {
  const attempted = useRef(new Set<string>());
  const owner = useRef(sessionId);
  owner.current = sessionId;
  const readRef = useRef(readDraft);
  readRef.current = readDraft;
  const writeRef = useRef(writeDraft);
  writeRef.current = writeDraft;
  const connected = connectionState.value === 'connected';

  useEffect(() => {
    if (!sessionId || !connected || attempted.current.has(sessionId)) return;
    const entry = buffer.read(sessionId);
    const hub = connectionManager.getHubIfConnected();
    if (!entry || !hub) return;
    attempted.current.add(sessionId);
    void invokeOperation<unknown>(hub, 'neo.draft.recover', {
      sessionId,
      text: entry.text,
      base: entry.base,
    })
      .then((result) => {
        if (owner.current !== sessionId) return;
        const settlement = settleNeoDraftRecovery(result, entry, readRef.current());
        if (settlement === 'restore') writeRef.current(entry.text);
        else if (settlement === 'forget') buffer.forget(sessionId, entry.id);
      })
      .catch(() => {
        attempted.current.delete(sessionId);
      });
  }, [sessionId, connected]);
}
