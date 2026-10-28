import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageHubRouter } from '@hyperneo/shared';
import { WebSocketServerTransport } from '../../../../src/lib/websocket-server-transport';
import type { RuntimeSocket } from '../../../../src/lib/runtime-server';
import { onDeviceRevoked } from '../../../../src/lib/pairing/upgrade-auth';

describe('connected device revocation observation', () => {
  let transport: WebSocketServerTransport;
  let read: ReturnType<typeof vi.fn<(ids: readonly string[]) => Promise<readonly string[]>>>;
  beforeEach(() => {
    vi.useFakeTimers();
    read = vi.fn(async (_ids: readonly string[]) => [] as readonly string[]);
    const options = { router: new MessageHubRouter(), readInactiveDevices: read };
    transport = new WebSocketServerTransport(options);
  });
  afterEach(async () => {
    await transport.close();
    vi.useRealTimers();
  });
  const socket = (deviceId?: string) => {
    let clientId = '';
    const ws = {
      data: { device: deviceId ? { deviceId, kind: 'human' } : null },
      readyState: 1,
      send: vi.fn(() => 1),
      close: vi.fn(() => {
        ws.readyState = 3;
        transport.unregisterClient(clientId);
      }),
    } satisfies RuntimeSocket;
    clientId = transport.registerClient(ws, 'synthetic');
    return { ws, clientId };
  };
  test('only confirmed inactive connected devices close, with IDs deduplicated', async () => {
    read.mockResolvedValue(['revoked']);
    const active = socket('active');
    const first = socket('revoked');
    const second = socket('revoked');
    const unknown = socket();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledWith(['active', 'revoked']);
    expect(first.ws.close).toHaveBeenCalledWith(1008, 'Device revoked');
    expect(second.ws.close).toHaveBeenCalledTimes(1);
    expect(active.ws.close).not.toHaveBeenCalled();
    expect(unknown.ws.close).not.toHaveBeenCalled();
  });
  test('unpaired and disconnected clients do not cause device reads', async () => {
    socket();
    const gone = socket('gone');
    transport.unregisterClient(gone.clientId);
    await transport.initialize();
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).not.toHaveBeenCalled();
  });
  test('initialization is idempotent and a pending read cannot overlap later ticks', async () => {
    let resolve!: (ids: readonly string[]) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    socket('active');
    await transport.initialize();
    await transport.initialize();
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(1);
    resolve([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  test('failed reads stay low-rate and close nothing until recovery confirms inactivity', async () => {
    read
      .mockRejectedValueOnce(new Error('synthetic offline'))
      .mockRejectedValueOnce(new Error('synthetic offline'))
      .mockResolvedValue(['revoked']);
    const target = socket('revoked');
    await transport.initialize();
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(target.ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(target.ws.close).toHaveBeenCalledTimes(1);
  });
  test('transport close stops future polls and ignores a late inactive result', async () => {
    let resolve!: (ids: readonly string[]) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const target = socket('revoked');
    await transport.initialize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    await transport.close();
    resolve(['revoked']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(target.ws.close).not.toHaveBeenCalled();
  });
  test('last disconnect suppresses a held inactive result and reconnection shares its flight', async () => {
    let resolve!: (ids: readonly string[]) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const target = socket('revoked');
    const notified = vi.fn();
    const unsubscribe = onDeviceRevoked(notified);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      transport.unregisterClient(target.clientId);
      resolve(['revoked']);
      await vi.advanceTimersByTimeAsync(2000);
      expect(notified).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      let finish!: (ids: readonly string[]) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          })
      );
      const first = socket('active');
      await vi.advanceTimersByTimeAsync(1000);
      transport.unregisterClient(first.clientId);
      socket('active');
      await vi.advanceTimersByTimeAsync(3000);
      expect(read).toHaveBeenCalledTimes(2);
      finish([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
    }
  });
});
