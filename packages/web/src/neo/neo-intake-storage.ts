import { generateUUID } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { neoIntakeSnapshots } from './neo-intake-snapshot.ts';

type Snapshot = Exclude<ReturnType<typeof neoIntakeSnapshots.decode>, { kind: string }>;
type Failure = {
  kind:
    | 'invalid_scope'
    | 'invalid_snapshot'
    | 'storage_unavailable'
    | 'snapshot_conflict'
    | 'storage_unconfirmed';
  revision?: string | null;
};
type Loaded = { snapshot: Snapshot; revision: string | null };
type Gate<T> = { value: T } | { reason: Failure };

function readStored(key: string, scope: string, getStorage: () => Storage): Gate<Loaded> {
  const raw = getStorage().getItem(key);
  if (raw === null) return { value: { snapshot: { version: 1, entries: [] }, revision: null } };
  const invalid: Gate<Loaded> = { reason: { kind: 'invalid_snapshot', revision: raw } };
  try {
    if (raw.length > neoIntakeSnapshots.limits.serializedCharacters + scope.length * 6 + 256)
      return invalid;
    const wrapper: unknown = JSON.parse(raw);
    if (
      !wrapper ||
      typeof wrapper !== 'object' ||
      Array.isArray(wrapper) ||
      Object.keys(wrapper).sort().join(',') !== 'scope,snapshot,writeId' ||
      !('scope' in wrapper) ||
      wrapper.scope !== scope ||
      !('writeId' in wrapper) ||
      typeof wrapper.writeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        wrapper.writeId
      ) ||
      !('snapshot' in wrapper)
    )
      return invalid;
    const snapshot = neoIntakeSnapshots.decode(JSON.stringify(wrapper.snapshot));
    return 'kind' in snapshot ? invalid : { value: { snapshot, revision: raw } };
  } catch {
    return invalid;
  }
}

function admitEntries(entries: unknown): Gate<string> {
  const encoded = neoIntakeSnapshots.encode(entries);
  return typeof encoded === 'string' ? { value: encoded } : { reason: encoded };
}

function requireRevision(
  encoded: string,
  storage: Storage,
  key: string,
  revision: { raw: string | null }
): Gate<string> {
  const current = storage.getItem(key);
  return current === revision.raw
    ? { value: encoded }
    : { reason: { kind: 'snapshot_conflict', revision: current } };
}

function writeStored(encoded: string, storage: Storage, key: string): Gate<string> {
  storage.setItem(key, encoded);
  return storage.getItem(key) === encoded
    ? { value: encoded }
    : { reason: { kind: 'storage_unconfirmed' } };
}

const readSnapshot = (superpipe({})('neo-intake-snapshot-read') as PipelineAPI)
  .input(['key', 'scope', 'getStorage'])
  .pipe(readStored, ['key', 'scope', 'getStorage'], 'result:stored')
  .end('stored') as (key: string, scope: string, getStorage: () => Storage) => Loaded | Failure;

const saveSnapshot = (superpipe({})('neo-intake-snapshot-save') as PipelineAPI)
  .input(['key', 'scope', 'getStorage', 'revision', 'entries'])
  .pipe(admitEntries, 'entries', 'result:encoded')
  .pipe((getStorage: () => Storage) => getStorage(), 'getStorage', 'storage')
  .pipe(requireRevision, ['encoded', 'storage', 'key', 'revision'], 'result:encoded')
  .pipe(
    (encoded: string, scope: string) =>
      JSON.stringify({ scope, writeId: generateUUID(), snapshot: JSON.parse(encoded) }),
    ['encoded', 'scope'],
    'encoded'
  )
  .pipe(writeStored, ['encoded', 'storage', 'key'], 'result:encoded')
  .end('encoded') as (
  key: string,
  scope: string,
  getStorage: () => Storage,
  revision: { raw: string | null },
  entries: unknown
) => string | Failure;

export function createNeoIntakeStorage(
  scope: string,
  getStorage: () => Storage = () => window.sessionStorage
) {
  let key: string | undefined;
  try {
    if (typeof scope === 'string' && scope && scope.length <= 2048 && scope.trim() === scope)
      key = `hyperneo_neo_intake_snapshot_v1.${encodeURIComponent(scope)}`;
  } catch {}
  return {
    read(): Loaded | Failure {
      if (!key) return { kind: 'invalid_scope' };
      try {
        return readSnapshot(key, scope, getStorage);
      } catch {
        return { kind: 'storage_unavailable' };
      }
    },
    save(expected: string | null, entries: unknown): { revision: string } | Failure {
      if (!key) return { kind: 'invalid_scope' };
      try {
        const saved = saveSnapshot(key, scope, getStorage, { raw: expected }, entries);
        return typeof saved === 'string' ? { revision: saved } : saved;
      } catch {
        return { kind: 'storage_unavailable' };
      }
    },
  };
}
