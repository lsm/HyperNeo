import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCursorDiscovery } from '../../../../src/lib/drivers/cursor-discovery.ts';

const peer = vi.hoisted(() => ({ created: vi.fn(), request: vi.fn(), close: vi.fn() }));

vi.mock('../../../../src/lib/process-json-rpc.ts', () => ({
  ProcessJsonRpcTransport: class {
    constructor(options: unknown) {
      peer.created(options);
    }
    sendRequest = peer.request;
    close = peer.close;
  },
}));

const adapter = createCursorDiscovery('cursor-agent', '/fixture', 'test');
const query = { includeClosed: false, limit: 1 };
const handshake = {
  result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } },
};
const first = { sessionId: 'first', cwd: '/first', title: 'First' };
const wanted = { sessionId: 'wanted', cwd: '/second' };

describe('Cursor CLI discovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('counts matching sessions toward the limit and searches later pages by title or exact ID', async () => {
    function pages() {
      peer.request
        .mockResolvedValueOnce(handshake)
        .mockResolvedValueOnce({ result: { sessions: [first], nextCursor: 'later' } })
        .mockResolvedValueOnce({ result: { sessions: [first, wanted], nextCursor: 'unused' } });
    }
    pages();
    const byTitle = await adapter.find({ ...query, text: 'untitled cursor session' });
    expect(byTitle.flatMap(({ work }) => work.map(({ ref }) => ref.id))).toEqual(['wanted']);
    expect(peer.request).toHaveBeenLastCalledWith('session/list', {
      cwd: undefined,
      cursor: 'later',
    });
    pages();
    const byId = await adapter.find({ ...query, id: 'wanted' });
    expect(byId.flatMap(({ work }) => work.map(({ ref }) => ref.id))).toEqual(['wanted']);
    expect(peer.request).toHaveBeenCalledTimes(6);
    expect(peer.close).toHaveBeenCalledTimes(2);
  });

  it('returns one place and one session when the requested limit is one', async () => {
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ result: { sessions: [first, wanted] } });
    const places = await adapter.find(query);
    expect(places.map(({ place, work }) => [place.folder, work.length])).toEqual([['/first', 1]]);
  });

  it('reports sign-in by the ACP error code even if the message changes', async () => {
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ error: { code: -32000, message: 'Please authenticate' } });
    await expect(adapter.find(query)).rejects.toThrow('Cursor CLI authentication required');
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid peer metadata and closes the connection', async () => {
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ result: { sessions: [{ sessionId: 'invalid', cwd: 'relative' }] } });
    await expect(adapter.find(query)).rejects.toThrow('invalid session metadata');
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('waits through a slow cursor-agent cold start before giving up on a request', async () => {
    let answer!: (value: unknown) => void;
    peer.request
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValueOnce({ result: { sessions: [first] } });
    vi.useFakeTimers();
    try {
      const found = adapter.find(query);
      await vi.advanceTimersByTimeAsync(12_000);
      answer(handshake);
      expect((await found).map(({ place }) => place.folder)).toEqual(['/first']);
      expect(peer.created).toHaveBeenCalledWith(
        expect.objectContaining({ requestTimeoutMs: 15_000 })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Cursor CLI history', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('replays an owned session over ACP into ordered turns and skips unowned ones', async () => {
    const owned = createCursorDiscovery('cursor-agent', '/fixture', 'test', async () => [
      ['owned', '/work'],
    ]);
    expect(await owned.readTurns!('other', undefined, 5, 0)).toBeNull();
    expect(peer.created).not.toHaveBeenCalled();

    const chunk = (sessionUpdate: string, text: string) => ({
      method: 'session/update',
      params: { sessionId: 'owned', update: { sessionUpdate, content: { type: 'text', text } } },
    });
    peer.request.mockImplementation(async (method: string, _params: unknown, options) => {
      if (method === 'initialize')
        return { result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } };
      const { onNotification } = peer.created.mock.calls[0][0] as {
        onNotification: (message: unknown) => void;
      };
      for (const message of [
        chunk('user_message_chunk', 'Fix the fictional bug'),
        chunk('agent_message_chunk', 'Looking. '),
        chunk('agent_message_chunk', 'Fixed.'),
        chunk('user_message_chunk', 'Thanks'),
      ])
        onNotification(message);
      options?.onResponseFrame?.();
      return { result: {} };
    });

    const page = await owned.readTurns!('owned', undefined, 5, 0);
    expect(peer.created).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'cursor-agent', args: ['acp'], cwd: '/work' })
    );
    expect(peer.request).toHaveBeenCalledWith(
      'session/load',
      { sessionId: 'owned', cwd: '/work', mcpServers: [] },
      expect.anything()
    );
    expect(page?.availability).toBe('complete');
    expect(page?.turns.map(({ messageId, role, text }) => [messageId, role, text])).toEqual([
      ['cursor:1', 'user', 'Fix the fictional bug'],
      ['cursor:2', 'assistant', 'Looking. Fixed.'],
      ['cursor:3', 'user', 'Thanks'],
    ]);
    expect(peer.close).toHaveBeenCalledOnce();
  });
});
