import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityAdapter } from '../../../../src/lib/drivers/antigravity-adapter.ts';
import type { FindQuery } from '../../../../src/lib/drivers/types.ts';

const peer = vi.hoisted(() => ({
  opened: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../../../src/lib/process-json-rpc.ts', () => ({
  ProcessJsonRpcTransport: class {
    constructor(options: unknown) {
      peer.opened(options);
    }
    sendRequest = peer.request;
    close = peer.close;
  },
}));

const adapter = createAntigravityAdapter('agy', 'fixture');
const query: FindQuery = { includeClosed: false, limit: 5 };
const handshake = {
  result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } },
};

describe('createAntigravityAdapter.find', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('filters across pages, groups and orders the matches, and closes the process', async () => {
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({
        result: {
          sessions: [
            { sessionId: 'task-other-folder', cwd: '/other', title: 'Build elsewhere' },
            { sessionId: 'task-other-title', cwd: '/work', title: 'Unrelated' },
            { sessionId: 'other-prefix', cwd: '/work', title: 'Build elsewhere' },
          ],
          nextCursor: 'second',
        },
      })
      .mockResolvedValueOnce({
        result: {
          sessions: [
            { sessionId: 'task-old', cwd: '/work', title: 'Build old' },
            {
              sessionId: 'task-new',
              cwd: '/work',
              title: 'Build new',
              updatedAt: '2026-08-01T00:00:00Z',
            },
          ],
        },
      });

    const groups = await adapter.find({
      ...query,
      folder: '/work',
      idPrefix: 'task-',
      text: 'bUiLd',
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ place: { folder: '/work' }, openCount: 2 });
    expect(groups[0].work.map((item) => [item.ref.adapter, item.ref.id, item.title])).toEqual([
      ['antigravity-cli', 'task-new', 'Build new'],
      ['antigravity-cli', 'task-old', 'Build old'],
    ]);
    expect(peer.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'session/list',
      'session/list',
    ]);
    expect(peer.request).toHaveBeenLastCalledWith('session/list', {
      cwd: '/work',
      cursor: 'second',
    });
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('stops when the server repeats a pagination cursor', async () => {
    peer.request.mockResolvedValue({ result: { sessions: [], nextCursor: 'repeated' } });
    peer.request.mockResolvedValueOnce(handshake);

    await expect(adapter.find(query)).rejects.toThrow('repeated an ACP session list cursor');
    expect(peer.request).toHaveBeenCalledTimes(3);
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('passes approved proxy and platform variables without inheriting unrelated environment', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:8080');
    vi.stubEnv('XDG_CONFIG_HOME', '/fixture/config');
    vi.stubEnv('ANTIGRAVITY_FIXTURE_PARENT_ONLY', 'parent');
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ result: { sessions: [] } });

    await expect(adapter.find(query)).resolves.toEqual([]);
    expect(peer.opened).toHaveBeenCalledWith(
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          HTTPS_PROXY: 'http://proxy.example.test:8080',
          XDG_CONFIG_HOME: '/fixture/config',
        }),
      })
    );
    expect(peer.opened.mock.calls[0][0].env).not.toHaveProperty('ANTIGRAVITY_FIXTURE_PARENT_ONLY');
  });

  it('bounds startup and listing together and closes a stalled process', async () => {
    vi.useFakeTimers();
    peer.request
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(handshake), 10_000))
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    const result = expect(adapter.find(query)).rejects.toThrow('session discovery timed out');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(peer.request).toHaveBeenCalledTimes(2);
    expect(peer.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(peer.close).toHaveBeenCalledOnce();
  });
});
