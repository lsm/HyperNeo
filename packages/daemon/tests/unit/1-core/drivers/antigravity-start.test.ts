import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityStart } from '../../../../src/lib/drivers/antigravity-start.ts';
import { withReplyLine } from '../../../../src/lib/messaging/session-reply.ts';
import { JsonRpcRequestTimeoutError } from '../../../../src/lib/process-json-rpc.ts';

const peer = vi.hoisted(() => ({
  created: vi.fn(),
  request: vi.fn(),
  respond: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../../../../src/lib/process-json-rpc.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/process-json-rpc.ts')>()),
  ProcessJsonRpcTransport: class {
    constructor(options: unknown) {
      peer.created(options);
    }
    sendRequest = peer.request;
    sendResponse = peer.respond;
    close = peer.close;
  },
}));

const ref = { adapter: 'antigravity-cli', id: 'owned-1' };
const handshake = {
  result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
};

describe('createAntigravityStart.start', () => {
  let folder: string;
  let driver: ReturnType<typeof createAntigravityStart>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    folder = mkdtempSync(join(tmpdir(), 'antigravity-start-test-'));
    driver = createAntigravityStart('agy', 'fixture', ref.adapter);
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ result: { sessionId: ref.id } });
  });

  afterEach(async () => {
    await driver.close();
    vi.useRealTimers();
    rmSync(folder, { recursive: true, force: true });
  });

  const start = (driver: ReturnType<typeof createAntigravityStart>, folder: string) =>
    driver.start({
      place: { machine: 'fixture', folder, name: 'Workspace' },
      title: 'Run',
      message: 'Hello',
    });

  it('keeps a turn over ten minutes running and saves it after completion', async () => {
    peer.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ result: { stopReason: 'end_turn' } }), 11 * 60_000);
          })
      )
      .mockResolvedValueOnce({ result: {} });

    expect(await start(driver, folder)).toMatchObject({
      ok: true,
      value: { ref, status: 'running' },
    });
    expect(peer.created).toHaveBeenCalledWith(
      expect.objectContaining({ requestTimeoutMs: 60 * 60_000 })
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await driver.status(ref)).toMatchObject({ ok: true, value: { status: 'running' } });
    expect(peer.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(await driver.status(ref)).toMatchObject({ ok: true, value: { status: 'done' } });
    expect(peer.request).toHaveBeenLastCalledWith('session/close', { sessionId: ref.id });
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('names its own session id in the start reply line', async () => {
    peer.request
      .mockResolvedValueOnce({ result: { stopReason: 'end_turn' } })
      .mockResolvedValueOnce({ result: {} });
    await driver.start({
      place: { machine: 'fixture', folder, name: 'Workspace' },
      title: 'Run',
      message: withReplyLine('Go.', 'session:neo%3Aroot', 'cli'),
    });
    expect(peer.request).toHaveBeenCalledWith(
      'session/prompt',
      {
        sessionId: ref.id,
        prompt: [
          {
            type: 'text',
            text: withReplyLine('Go.', 'session:neo%3Aroot', 'cli', 'antigravity-cli:owned-1'),
          },
        ],
      },
      expect.anything()
    );
  });

  it('reports when the turn reached its time limit', async () => {
    peer.request.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          const { requestTimeoutMs } = peer.created.mock.calls[0][0];
          setTimeout(
            () => reject(new JsonRpcRequestTimeoutError('session/prompt', requestTimeoutMs)),
            requestTimeoutMs
          );
        })
    );

    expect(await start(driver, folder)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const result = await driver.status(ref);
    expect(result).toMatchObject({ ok: true, value: { status: 'failed' } });
    expect(result.ok && result.value.turnEnds?.[0].message).toContain(
      'exceeded the 60-minute limit'
    );
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('reports an actual transport disconnection separately', async () => {
    peer.request.mockRejectedValueOnce(new Error('JSON-RPC process exited'));

    expect(await start(driver, folder)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    const result = await driver.status(ref);
    expect(result).toMatchObject({ ok: true, value: { status: 'failed' } });
    expect(result.ok && result.value.turnEnds?.[0].message).toContain(
      'disconnected during the turn'
    );
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('answers permission requests through the reply-command gate', async () => {
    peer.request.mockReturnValueOnce(new Promise(() => {}));
    expect(await start(driver, folder)).toMatchObject({ ok: true });
    const { onRequest } = peer.created.mock.calls[0][0];
    const permission = (CommandLine: string) => ({
      toolCall: { kind: 'execute', rawInput: { CommandLine } },
      options: [{ optionId: 'allow', kind: 'allow_once' }],
    });

    onRequest({
      id: 7,
      method: 'session/request_permission',
      params: permission('hyperneo send session:a hi'),
    });
    onRequest({ id: 8, method: 'session/request_permission', params: permission('rm -rf ~') });

    expect(peer.respond).toHaveBeenCalledWith(7, {
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(peer.respond).toHaveBeenCalledWith(8, { outcome: { outcome: 'cancelled' } });
  });
});
