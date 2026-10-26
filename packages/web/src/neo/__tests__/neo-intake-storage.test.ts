import { describe, expect, it, vi } from 'vitest';
import { createNeoIntakeClient } from '../neo-intake.ts';

const entry = () => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'neo:10000000-0000-4000-8000-000000000001',
  text: 'Original pending reply',
  images: [],
  previewContext: {
    artifactId: 'report',
    snapshot: 'a'.repeat(64),
    displayName: 'Original report',
    state: 'unavailable',
  },
  createdAt: '2026-10-25T23:00:00.000Z',
  state: 'failed',
  reason: 'Receipt unknown',
});

function setup() {
  const values = new Map<string, string>();
  const get = vi.fn((key: string) => values.get(key) ?? null);
  const set = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  const remove = vi.fn((key: string) => {
    values.delete(key);
  });
  const storage: Storage = {
    get length() {
      return values.size;
    },
    getItem: get,
    setItem: set,
    removeItem: remove,
    key: (n) => [...values.keys()][n] ?? null,
    clear: () => values.clear(),
  };
  const getStorage = vi.fn(() => storage);
  const getHub = vi.fn(async () => {
    throw new Error('No transport');
  });
  const client = createNeoIntakeClient(getHub);
  const port = (scope = 'daemon-a') => client.snapshots.storage(scope, getStorage);
  return { values, get, set, remove, getStorage, getHub, client, port };
}

function saved(result: { revision: string } | { kind: string }) {
  if ('kind' in result) throw new Error(`Unexpected refusal: ${result.kind}`);
  return result.revision;
}

describe('Neo intake scoped snapshot storage', () => {
  it('constructs without touching storage or transport and distinguishes absent state', () => {
    const env = setup();
    const port = env.port();
    expect(env.getStorage).not.toHaveBeenCalled();
    expect(port.read()).toEqual({ snapshot: { version: 1, entries: [] }, revision: null });
    expect(env.getHub).not.toHaveBeenCalled();
    expect(env.set).not.toHaveBeenCalled();
  });

  it('roundtrips an exact snapshot through a fresh adapter with opaque revisions', () => {
    const env = setup();
    const original = entry();
    const revision = saved(env.port().save(null, [original]));
    original.previewContext.snapshot = 'b'.repeat(64);
    expect(env.port().read()).toEqual({ snapshot: { version: 1, entries: [entry()] }, revision });
    expect(env.getHub).not.toHaveBeenCalled();
    expect(env.remove).not.toHaveBeenCalled();
  });

  it('isolates namespaces including URI punctuation', () => {
    const env = setup();
    const first = saved(env.port('ws://daemon/a').save(null, [entry()]));
    const second = saved(env.port('ws%3A%2F%2Fdaemon%2Fa').save(null, []));
    expect(first).not.toBe(second);
    expect(env.values.size).toBe(2);
    expect(env.port('ws://daemon/a').read()).toEqual({
      snapshot: { version: 1, entries: [entry()] },
      revision: first,
    });
    expect(env.port('daemon-new').read()).toEqual({
      snapshot: { version: 1, entries: [] },
      revision: null,
    });
  });

  it.each(['', ' ', ' padded', 'x'.repeat(2049), '\ud800'])(
    'refuses an invalid scope without storage access: %j',
    (scope) => {
      const env = setup();
      const port = env.port(scope);
      expect(port.read()).toEqual({ kind: 'invalid_scope' });
      expect(port.save(null, [entry()])).toEqual({ kind: 'invalid_scope' });
      expect(env.getStorage).not.toHaveBeenCalled();
    }
  );

  it('refuses stale and ABA writers without changing the current record', () => {
    const env = setup();
    const port = env.port();
    const first = saved(port.save(null, [entry()]));
    const empty = saved(port.save(first, []));
    const again = saved(port.save(empty, [entry()]));
    expect(again).not.toBe(first);
    expect(port.save(first, [])).toMatchObject({ kind: 'snapshot_conflict' });
    expect(port.save(null, [])).toMatchObject({ kind: 'snapshot_conflict' });
    expect(port.read()).toEqual({ snapshot: { version: 1, entries: [entry()] }, revision: again });
    expect(env.set).toHaveBeenCalledTimes(3);
  });

  it('validates whole candidate capacity before accessing storage', () => {
    const env = setup();
    const port = env.port();
    const rows = Array.from({ length: 21 }, (_, n) => ({
      ...entry(),
      requestId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));
    expect(port.save(null, rows)).toEqual({ kind: 'invalid_snapshot' });
    expect(port.save(null, [{ ...entry(), previewContext: null }])).toEqual({
      kind: 'invalid_snapshot',
    });
    expect(env.getStorage).not.toHaveBeenCalled();
    expect(env.set).not.toHaveBeenCalled();
  });

  it.each(['access', 'read'])('does not substitute empty state for a %s failure', (failure) => {
    const env = setup();
    const port = env.port();
    if (failure === 'access')
      env.getStorage.mockImplementation(() => {
        throw new Error('denied');
      });
    else
      env.get.mockImplementation(() => {
        throw new Error('denied');
      });
    expect(port.read()).toEqual({ kind: 'storage_unavailable' });
    expect(env.set).not.toHaveBeenCalled();
  });

  it.each(['corrupt', 'foreign', 'unknown', 'bad-generation', 'future-snapshot', 'huge-wrapper'])(
    'retains %s stored data with a revision for later explicit recovery',
    (failure) => {
      const env = setup();
      const port = env.port();
      const good = saved(port.save(null, [entry()]));
      const key = [...env.values.keys()][0];
      const wrapper = JSON.parse(good);
      if (failure === 'foreign') wrapper.scope = 'daemon-other';
      if (failure === 'unknown') wrapper.sourcePath = '/untrusted';
      if (failure === 'bad-generation') wrapper.writeId = 'bad';
      if (failure === 'future-snapshot') wrapper.snapshot.version = 2;
      const raw =
        failure === 'corrupt'
          ? '{broken'
          : failure === 'huge-wrapper'
            ? ' '.repeat(16 * 1024 * 1024 + 20_000)
            : JSON.stringify(wrapper);
      env.values.set(key, raw);
      env.set.mockClear();
      expect(port.read()).toEqual({ kind: 'invalid_snapshot', revision: raw });
      expect(env.values.get(key)).toBe(raw);
      expect(env.set).not.toHaveBeenCalled();
      expect(port.save(null, [])).toMatchObject({ kind: 'snapshot_conflict' });
      const reset = saved(port.save(raw, []));
      expect(port.read()).toEqual({ snapshot: { version: 1, entries: [] }, revision: reset });
    }
  );

  it('preserves the last good record on quota failure without removing it', () => {
    const env = setup();
    const port = env.port();
    const revision = saved(port.save(null, [entry()]));
    env.set.mockImplementation(() => {
      throw new Error('quota');
    });
    expect(port.save(revision, [])).toEqual({ kind: 'storage_unavailable' });
    expect(port.read()).toEqual({ snapshot: { version: 1, entries: [entry()] }, revision });
    expect(env.remove).not.toHaveBeenCalled();
  });

  it('does not confirm a silently dropped write', () => {
    const env = setup();
    const port = env.port();
    const revision = saved(port.save(null, [entry()]));
    env.set.mockImplementation(() => {});
    expect(port.save(revision, [])).toMatchObject({ kind: 'storage_unconfirmed' });
    expect(port.read()).toEqual({ snapshot: { version: 1, entries: [entry()] }, revision });
  });

  it('does not acknowledge or roll back a different value observed after writing', () => {
    const env = setup();
    const port = env.port();
    const revision = saved(port.save(null, [entry()]));
    env.set.mockImplementation((key) => {
      env.values.set(key, 'different-writer');
    });
    expect(port.save(revision, [])).toMatchObject({ kind: 'storage_unconfirmed' });
    expect([...env.values.values()]).toEqual(['different-writer']);
    expect(env.remove).not.toHaveBeenCalled();
  });

  it('reports an ambiguous write failure without pretending it was saved', () => {
    const env = setup();
    const port = env.port();
    env.set.mockImplementation((key, value) => {
      env.values.set(key, value);
      throw new Error('lost acknowledgement');
    });
    expect(port.save(null, [entry()])).toEqual({ kind: 'storage_unavailable' });
    const loaded = port.read();
    if ('kind' in loaded) throw new Error('Unexpected refusal');
    expect(loaded.snapshot.entries).toEqual([entry()]);
    expect(env.getHub).not.toHaveBeenCalled();
  });

  it('reports a read-back access failure without confirming or rolling back the write', () => {
    const env = setup();
    const port = env.port();
    env.get
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => {
        throw new Error('read-back denied');
      });
    expect(port.save(null, [entry()])).toEqual({ kind: 'storage_unavailable' });
    const loaded = port.read();
    if ('kind' in loaded) throw new Error('Unexpected refusal');
    expect(loaded.snapshot.entries).toEqual([entry()]);
    expect(env.remove).not.toHaveBeenCalled();
    expect(env.getHub).not.toHaveBeenCalled();
  });

  it('defers default browser storage access and reports a disabled accessor', () => {
    const client = createNeoIntakeClient(async () => {
      throw new Error('No transport');
    });
    const access = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('Browser storage disabled');
    });
    try {
      const port = client.snapshots.storage('disabled-browser');
      expect(access).not.toHaveBeenCalled();
      expect(port.read()).toEqual({ kind: 'storage_unavailable' });
      expect(port.save(null, [entry()])).toEqual({ kind: 'storage_unavailable' });
    } finally {
      access.mockRestore();
    }
  });
});
