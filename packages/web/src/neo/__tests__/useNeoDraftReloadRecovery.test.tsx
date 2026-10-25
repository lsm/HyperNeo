import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { useLayoutEffect } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionState } from '../../lib/state.ts';
import { createNeoDraftReloadBuffer } from '../neo-draft-reload-buffer.ts';
import { useNeoDraftReloadRecovery } from '../useNeoDraftReloadRecovery.ts';

const seams = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHubIfConnected: () => ({ request: seams.request }) },
}));
const scope = 'neo:synthetic-recovery';
const reference: NeoPreviewReference = {
  artifactId: 'registered-report',
  snapshot: 'a'.repeat(64),
  displayName: 'Original title',
  state: 'available',
};
const metadata = (artifactId = reference.artifactId, sha256 = reference.snapshot) => ({
  accepted: true,
  metadata: { artifact: { artifactId, title: 'Renamed title' }, sha256 },
});
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  sessionStorage.clear();
  connectionState.value = 'connected';
  seams.request.mockReset();
  seams.request.mockImplementation(async (_method, input) =>
    input.name === 'artifact.file.get' ? metadata() : { ok: true }
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
function mount(
  context?: NeoPreviewReference | null,
  captured = true,
  editBeforePassiveEffects = false,
  capturedText = 'Captured reply'
) {
  let refuse = false;
  const storage = new Proxy(window.sessionStorage, {
    get(target, name) {
      if (name === 'setItem' && refuse)
        return () => {
          throw new Error('quota');
        };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const buffer = createNeoDraftReloadBuffer(() => storage);
  if (captured) expect(buffer.remember(scope, capturedText, 'Saved baseline', context)).toBe(true);
  let visible = '';
  let version = 0;
  const write = vi.fn((text: string, _context?: NeoPreviewReference | null) => {
    visible = text;
  });
  function Harness({ sessionId }: { sessionId: string | null; epoch: number }) {
    const ready = useNeoDraftReloadRecovery(
      sessionId,
      buffer,
      () => visible,
      write,
      () => version
    );
    useLayoutEffect(() => {
      if (editBeforePassiveEffects) version += 1;
    }, []);
    return <output data-testid="ready">{String(ready)}</output>;
  }
  const view = render(<Harness sessionId={scope} epoch={version} />);
  return {
    ...view,
    write,
    buffer,
    refuseWrites: () => {
      refuse = true;
    },
    setVisible: (text: string) => {
      visible = text;
    },
    edit: () => {
      version += 1;
    },
    select: (sessionId: string | null) =>
      view.rerender(<Harness sessionId={sessionId} epoch={version} />),
    rerender: () => view.rerender(<Harness sessionId={scope} epoch={version} />),
  };
}
const ready = () => screen.getByTestId('ready').textContent;
const recoveryCalls = () =>
  seams.request.mock.calls.filter(([, input]) => input.name === 'neo.draft.recover');

describe('useNeoDraftReloadRecovery', () => {
  it('returns original text and exact reauthorized reference together after metadata completes', async () => {
    const gate = deferred();
    seams.request.mockImplementation(async (_method, input) =>
      input.name === 'artifact.file.get' ? gate.promise : { ok: true }
    );
    const view = mount({ ...reference, state: 'unavailable' });
    expect(ready()).toBe('false');
    await waitFor(() => expect(seams.request).toHaveBeenCalledTimes(2));
    expect(view.write).not.toHaveBeenCalled();
    await act(async () => gate.resolve(metadata()));
    await waitFor(() => expect(ready()).toBe('true'));
    expect(view.write).toHaveBeenCalledExactlyOnceWith('Captured reply', reference);
    expect(recoveryCalls()[0][1].input).toEqual({
      sessionId: scope,
      text: 'Captured reply',
      base: 'Saved baseline',
      previewContext: { artifactId: reference.artifactId, snapshot: reference.snapshot },
    });
  });
  it.each([
    ['hash mismatch', metadata(reference.artifactId, 'b'.repeat(64))],
    ['different artifact', metadata('different-artifact')],
    ['revoked', { accepted: false, reason: 'unavailable' }],
    ['missing metadata', { accepted: true }],
  ])('preserves identity as unavailable after %s', async (_label, response) => {
    seams.request.mockImplementation(async (_method, input) =>
      input.name === 'artifact.file.get' ? response : { ok: true }
    );
    const view = mount(reference);
    await waitFor(() => expect(ready()).toBe('true'));
    expect(view.write).toHaveBeenCalledExactlyOnceWith('Captured reply', {
      ...reference,
      state: 'unavailable',
    });
  });
  it('marks metadata transport failure unavailable', async () => {
    seams.request.mockImplementation(async (_method, input) => {
      if (input.name === 'artifact.file.get') throw new Error('offline');
      return { ok: true };
    });
    const view = mount(reference);
    await waitFor(() => expect(ready()).toBe('true'));
    expect(view.write).toHaveBeenCalledExactlyOnceWith('Captured reply', {
      ...reference,
      state: 'unavailable',
    });
  });
  it.each([null, undefined])(
    'preserves unbound/legacy context %s without metadata requests',
    async (context) => {
      const view = mount(context);
      await waitFor(() => expect(ready()).toBe('true'));
      expect(view.write).toHaveBeenCalledExactlyOnceWith('Captured reply', context);
      expect(seams.request).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['superseded', 'submitted'])(
    'forgets refused capture for %s and releases adoption',
    async (reason) => {
      seams.request.mockResolvedValue({ ok: false, reason });
      const view = mount(reference);
      await waitFor(() => expect(ready()).toBe('true'));
      expect(view.buffer.read(scope)).toBeNull();
      expect(view.write).not.toHaveBeenCalled();
    }
  );
  it('releases baseline adoption after a recovery transport failure while retaining capture', async () => {
    seams.request.mockRejectedValue(new Error('offline'));
    const view = mount(reference);
    await waitFor(() => expect(ready()).toBe('true'));
    expect(view.buffer.read(scope)?.text).toBe('Captured reply');
    expect(view.write).not.toHaveBeenCalled();
  });
  it.each(['different text', 'new capture', 'failed durable rebind'])(
    'rejects stale completion after %s',
    async (choice) => {
      const gate = deferred();
      seams.request.mockImplementation(async (_method, input) =>
        input.name === 'artifact.file.get' ? gate.promise : { ok: true }
      );
      const view = mount(reference);
      await waitFor(() => expect(seams.request).toHaveBeenCalledTimes(2));
      if (choice === 'different text') view.setVisible('New visible text');
      else if (choice === 'new capture')
        view.buffer.remember(scope, 'Captured reply', undefined, null);
      else {
        const prior = view.buffer.read(scope);
        view.refuseWrites();
        view.edit();
        expect(view.buffer.remember(scope, 'Captured reply', undefined, null)).toBe(false);
        expect(view.buffer.read(scope)).toEqual(prior);
      }
      await act(async () => gate.resolve(metadata()));
      expect(view.write).not.toHaveBeenCalled();
      expect(ready()).toBe('false');
    }
  );
  it('keeps the human version guard across reconnect even when durable rebind fails', async () => {
    const gate = deferred();
    seams.request.mockImplementation(async (_method, input) =>
      input.name === 'artifact.file.get' ? gate.promise : { ok: true }
    );
    const view = mount(reference);
    await waitFor(() => expect(seams.request).toHaveBeenCalledTimes(2));
    view.edit();
    view.refuseWrites();
    expect(view.buffer.remember(scope, 'Captured reply', undefined, null)).toBe(false);
    await act(async () => {
      connectionState.value = 'disconnected';
    });
    await act(async () => {
      connectionState.value = 'connected';
    });
    await act(async () => gate.resolve(metadata()));
    expect(view.write).not.toHaveBeenCalled();
    expect(ready()).toBe('false');
    expect(recoveryCalls()).toHaveLength(1);
  });
  it('does not forget a newer capture when an older recovery is refused', async () => {
    const gate = deferred();
    seams.request.mockReturnValue(gate.promise);
    const view = mount(reference);
    await waitFor(() => expect(recoveryCalls()).toHaveLength(1));
    view.buffer.remember(scope, 'New capture', undefined, null);
    await act(async () => gate.resolve({ ok: false, reason: 'submitted' }));
    expect(view.buffer.read(scope)?.text).toBe('New capture');
    expect(view.write).not.toHaveBeenCalled();
  });
  it.each(['scope', 'connection'])(
    'rejects stale authorization across roundtrip %s changes',
    async (change) => {
      const first = deferred();
      const second = deferred();
      let reads = 0;
      seams.request.mockImplementation(async (_method, input) =>
        input.name === 'artifact.file.get'
          ? ++reads === 1
            ? first.promise
            : second.promise
          : { ok: true }
      );
      const view = mount(reference);
      await waitFor(() => expect(reads).toBe(1));
      if (change === 'scope') {
        view.select('neo:other');
        view.select(scope);
      } else {
        await act(async () => {
          connectionState.value = 'disconnected';
        });
        await act(async () => {
          connectionState.value = 'connected';
        });
      }
      await waitFor(() => expect(reads).toBe(2));
      await act(async () => first.resolve(metadata()));
      expect(view.write).not.toHaveBeenCalled();
      expect(ready()).toBe('false');
      await act(async () => second.resolve(metadata()));
      await waitFor(() => expect(ready()).toBe('true'));
      expect(view.write).toHaveBeenCalledExactlyOnceWith('Captured reply', reference);
    }
  );
  it.each(['rpc', 'metadata'])(
    'settles the newest local capture after pending %s without restoring old text',
    async (phase) => {
      const gate = deferred();
      let saved = 'Saved baseline';
      let recoveryCount = 0;
      seams.request.mockImplementation(async (_method, request) => {
        if (request.name === 'artifact.file.get')
          return phase === 'metadata' ? gate.promise : metadata();
        const { input } = request;
        recoveryCount += 1;
        if (recoveryCount === 1 && phase === 'rpc') await gate.promise;
        if (input.base !== saved && input.text !== saved)
          return { ok: false, reason: 'superseded' };
        saved = input.text;
        return { ok: true };
      });
      const view = mount(reference);
      await waitFor(() => expect(recoveryCalls()).toHaveLength(1));
      if (phase === 'metadata') await waitFor(() => expect(seams.request).toHaveBeenCalledTimes(2));
      view.edit();
      view.setVisible('');
      expect(view.buffer.remember(scope, '', 'Saved baseline', null)).toBe(true);
      const newest = view.buffer.read(scope);
      view.rerender();
      if (phase === 'rpc') expect(recoveryCalls()).toHaveLength(1);
      await act(async () => gate.resolve(metadata()));
      await waitFor(() => expect(ready()).toBe('true'));
      expect(saved).toBe('');
      expect(recoveryCalls()).toHaveLength(2);
      expect(recoveryCalls()[1][1].input).toEqual({
        sessionId: scope,
        text: '',
        base: 'Captured reply',
        previewContext: null,
      });
      expect(view.write).not.toHaveBeenCalled();
      expect(view.buffer.read(scope)).toEqual(newest);
    }
  );

  it('uses the normalized server base after recovering whitespace around the original edit', async () => {
    const gate = deferred();
    let saved = 'Saved baseline';
    seams.request.mockImplementation(async (_method, request) => {
      if (request.input.text.includes('Captured reply')) await gate.promise;
      if (request.input.base !== saved) return { ok: false, reason: 'superseded' };
      saved = request.input.text.trim();
      return { ok: true };
    });
    const view = mount(null, true, false, '  Captured reply  ');
    await waitFor(() => expect(recoveryCalls()).toHaveLength(1));
    view.edit();
    view.setVisible('');
    view.buffer.remember(scope, '', 'Saved baseline', null);
    view.rerender();
    await act(async () => gate.resolve({ ok: true }));
    await waitFor(() => expect(ready()).toBe('true'));
    expect(saved).toBe('');
    expect(recoveryCalls()[1][1].input.base).toBe('Captured reply');
    expect(view.write).not.toHaveBeenCalled();
  });

  it('keeps the confirmed server base across multiple queued replacement captures', async () => {
    const gate = deferred();
    let saved = 'Saved baseline';
    seams.request.mockImplementation(async (_method, request) => {
      if (request.input.text === 'Captured reply') await gate.promise;
      if (request.input.base !== saved) return { ok: false, reason: 'superseded' };
      saved = request.input.text;
      return { ok: true };
    });
    const view = mount(reference);
    await waitFor(() => expect(recoveryCalls()).toHaveLength(1));
    for (const text of ['First local replacement', 'Newest local replacement']) {
      view.edit();
      view.setVisible(text);
      view.buffer.remember(scope, text, 'Saved baseline', null);
      view.rerender();
    }
    const newest = view.buffer.read(scope);
    await act(async () => gate.resolve({ ok: true }));
    await waitFor(() => expect(ready()).toBe('true'));
    expect(saved).toBe('Newest local replacement');
    expect(recoveryCalls()).toHaveLength(2);
    expect(recoveryCalls()[1][1].input.base).toBe('Captured reply');
    expect(view.buffer.read(scope)).toEqual(newest);
    expect(view.write).not.toHaveBeenCalled();
  });

  it('does not start another recovery for ordinary edits after initial recovery settled', async () => {
    const view = mount(reference);
    await waitFor(() => expect(ready()).toBe('true'));
    view.write.mockClear();
    view.edit();
    view.setVisible('Later edit');
    view.buffer.remember(scope, 'Later edit', undefined, null);
    view.rerender();
    await act(async () => {});
    expect(ready()).toBe('true');
    expect(recoveryCalls()).toHaveLength(1);
    expect(view.write).not.toHaveBeenCalled();
  });

  it('stays ready for new captures after mounting without recovery', async () => {
    const view = mount(undefined, false);
    await waitFor(() => expect(ready()).toBe('true'));
    view.buffer.remember(scope, 'New human edit', undefined, reference);
    view.rerender();
    expect(ready()).toBe('true');
    expect(recoveryCalls()).toHaveLength(0);
  });
  it('captures edit ownership before a human change ahead of passive effects', async () => {
    const gate = deferred();
    seams.request.mockReturnValue(gate.promise);
    const view = mount(null, true, true);
    expect(recoveryCalls()).toHaveLength(0);
    await act(async () => gate.resolve({ ok: true }));
    expect(view.write).not.toHaveBeenCalled();
    expect(ready()).toBe('false');
  });
  it('ignores completion after unmount', async () => {
    const gate = deferred();
    seams.request.mockReturnValue(gate.promise);
    const view = mount(reference);
    await waitFor(() => expect(recoveryCalls()).toHaveLength(1));
    view.unmount();
    await act(async () => gate.resolve({ ok: true }));
    expect(view.write).not.toHaveBeenCalled();
  });
});
