import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { loadArtifactMetadata } from '../lib/artifact-preview-client.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n/index.ts';
import { invokeOperation } from '../lib/operations.ts';
import { connectionState } from '../lib/state.ts';
import {
  type NeoDraftReloadEntry,
  type createNeoDraftReloadBuffer,
  neoDraftRecoveryInput,
} from './neo-draft-reload-buffer.ts';

type Buffer = ReturnType<typeof createNeoDraftReloadBuffer>;
type Recovery = { ok: true } | { ok: false; reason: string };
type RecoveryFlight = {
  attempted?: string;
  confirmed?: string;
  promise: Promise<unknown>;
  handoff?: SendHandoff;
};
type SendHandoff = { id?: string; version: unknown; done: boolean; pending?: Promise<void> };
const invalidatedHandoff = Symbol('invalidated-handoff');
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
): { ready: boolean; handoff: () => Promise<void> } {
  const readRef = useRef(readDraft);
  readRef.current = readDraft;
  const writeRef = useRef(writeDraft);
  writeRef.current = writeDraft;
  const versionRef = useRef(readVersion);
  versionRef.current = readVersion;
  const owner = useRef(sessionId);
  const captures = useRef(new Map<string, { id: string; version: unknown }>());
  const flights = useRef(new Map<string, RecoveryFlight>());
  const activeHandoff = sessionId ? flights.current.get(sessionId)?.handoff : null;
  if (activeHandoff && !activeHandoff.done && activeHandoff.version !== invalidatedHandoff) {
    const version = versionRef.current();
    if (owner.current !== sessionId) activeHandoff.version = version;
    else if (activeHandoff.version !== version) activeHandoff.version = invalidatedHandoff;
  }
  owner.current = sessionId;
  const connected = connectionState.value === 'connected';
  const key = JSON.stringify([sessionId, connected]);
  const generation = useRef({ key, ticket: 0 });
  if (generation.current.key !== key)
    generation.current = { key, ticket: generation.current.ticket + 1 };
  const ticket = generation.current.ticket;
  const [settled, setSettled] = useState(() => (sessionId && buffer.read(sessionId) ? -1 : ticket));

  const pendingId = sessionId && settled !== ticket ? buffer.read(sessionId)?.id : null;
  const origin = useRef({ ticket, id: pendingId });
  if (origin.current.ticket !== ticket) origin.current = { ticket, id: pendingId };

  useLayoutEffect(() => {
    if (settled === ticket) return;
    const entry = sessionId ? buffer.read(sessionId) : null;
    const transferred = sessionId ? flights.current.get(sessionId)?.handoff : null;
    if (transferred && (!entry || transferred.id === entry.id)) {
      if (transferred.done) setSettled(ticket);
      else if (connected) void handoff().catch(() => {});
      return;
    }
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
      flights.current.get(sessionId)?.handoff?.id !== entry.id &&
      versionRef.current() === version &&
      buffer.read(sessionId)?.id === entry.id;
    const flight: RecoveryFlight = flights.current.get(sessionId) ?? {
      promise: Promise.resolve(null),
    };
    const promise = flight.promise
      .catch(() => null)
      .then(() => {
        if (!current()) return null;
        const input = neoDraftRecoveryInput(entry);
        if (flight.confirmed !== undefined) input.base = flight.confirmed;
        flight.attempted = entry.text.trim();
        return invokeOperation<unknown>(hub, 'neo.draft.recover', input).then((response) => {
          if ('value' in admitNeoDraftRecovery(response)) flight.confirmed = entry.text.trim();
          return response;
        });
      });
    flight.promise = promise;
    flights.current.set(sessionId, flight);
    void promise
      .then(async (result) => {
        if (!current()) return;
        const settlement = settleNeoDraftRecovery(result, entry, readRef.current());
        if (settlement === 'restore' && entry.id === origin.current.id) {
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
  }, [sessionId, connected, ticket, pendingId]);
  const entry = sessionId ? buffer.read(sessionId) : null;
  const transferred = sessionId ? flights.current.get(sessionId)?.handoff : null;
  const ready =
    transferred && (!entry || entry.id === transferred.id)
      ? transferred.done
      : !sessionId || !entry || settled === ticket;
  function handoff(): Promise<void> {
    if (!sessionId || ready) return Promise.resolve();
    const scope = sessionId;
    const captured = buffer.read(scope);
    const flight: RecoveryFlight = flights.current.get(scope) ?? { promise: Promise.resolve(null) };
    const previous = flight.handoff;
    const claim: SendHandoff =
      previous && (!captured || previous.id === captured.id)
        ? previous
        : {
            id: captured?.id,
            version: versionRef.current(),
            done: false,
          };
    if (claim.pending) return claim.pending;
    flight.handoff = claim;
    const untouched = () =>
      flights.current.get(scope)?.handoff === claim &&
      claim.version !== invalidatedHandoff &&
      (!buffer.read(scope) || buffer.read(scope)?.id === claim.id) &&
      (owner.current !== scope || versionRef.current() === claim.version);
    const pending: Promise<void> = flight.promise
      .catch((error) => {
        if (!previous) throw error;
      })
      .then(async () => {
        if (!untouched()) return;
        const hub = connectionManager.getHubIfConnected();
        if (!hub) throw new Error(t('composer.reconnecting'));
        const expected = flight.confirmed ?? flight.attempted ?? captured?.text.trim() ?? '';
        const result = await hub.request<{ cleared?: boolean }>('session.clearInputDraftIf', {
          sessionId: scope,
          expected,
        });
        if (result.cleared) flight.confirmed = '';
        if (!untouched()) return;
        claim.done = true;
        if (owner.current === scope) setSettled(generation.current.ticket);
      })
      .finally(() => {
        if (claim.pending === pending) claim.pending = undefined;
      });
    claim.pending = pending;
    flight.promise = pending;
    flights.current.set(scope, flight);
    return pending;
  }
  return { ready, handoff };
}
