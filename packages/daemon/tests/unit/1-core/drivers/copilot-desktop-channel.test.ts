import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  callCopilotDesktop,
  copilotDesktopControlAvailable,
  readCopilotDesktopEndpoint,
} from '../../../../src/lib/drivers/copilot-desktop-channel';

const cleanups: (() => Promise<void>)[] = [];
const request = { type: 'send_message', request_id: 'request-1', session_id: 'session-1' };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function peer(reply?: object) {
  const home = mkdtempSync(join(tmpdir(), 'copilot-channel-'));
  const directory = join(home, '.copilot', 'run');
  mkdirSync(directory, { recursive: true });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture socket');
  server.on('connection', (socket) => {
    socket.once('message', () => {
      if (reply) socket.send(JSON.stringify(reply));
      else socket.close();
    });
  });
  const token = randomUUID();
  const tokenPath = join(directory, 'ws.token');
  const publish = (pid: number) => {
    writeFileSync(join(directory, 'ws.port'), `${address.port}\n${pid}\n`, { mode: 0o600 });
    writeFileSync(tokenPath, `${token}\n${pid}\n`, { mode: 0o600 });
  };
  publish(process.pid);
  return { home, publish, tokenPath };
}

describe('Copilot Desktop local channel', () => {
  test.each([
    [{ type: 'error', request_id: 'request-1', session_id: 'session-1' }, 'not_delivered'],
    [{ type: 'error', request_id: 'request-2', session_id: 'session-1' }, 'unreachable'],
    [{ type: 'error', request_id: 'request-1', session_id: 'session-2' }, 'unreachable'],
    [{ type: 'error' }, 'unreachable'],
    [{ type: 'session_message_delivery_unknown', session_id: 'session-1' }, 'unreachable'],
    [undefined, 'unreachable'],
  ] as const)('classifies a refusal only for the matching request (%p)', async (reply, reason) => {
    const fixture = await peer(reply);
    const endpoint = readCopilotDesktopEndpoint(fixture.home);
    expect(endpoint).not.toBeNull();
    const result = await callCopilotDesktop(endpoint!, request, () => undefined);
    expect(result).toMatchObject({ ok: false, reason });
    expect(result).not.toHaveProperty('notSent');
  });

  test('refuses an advertised PID that does not own the listener', async () => {
    const fixture = await peer();
    fixture.publish(process.ppid);
    expect(readCopilotDesktopEndpoint(fixture.home) === null).toBe(true);
    expect(copilotDesktopControlAvailable(fixture.home)).toBe(false);
  });

  test('refuses an endpoint with a non-private token file', async () => {
    const fixture = await peer();
    chmodSync(fixture.tokenPath, 0o644);
    expect(readCopilotDesktopEndpoint(fixture.home) === null).toBe(true);
    expect(copilotDesktopControlAvailable(fixture.home)).toBe(false);
  });
});
