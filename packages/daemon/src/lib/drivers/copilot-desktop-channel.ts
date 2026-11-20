import { constants, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Result } from './types.ts';
import { reject } from './work-operations.ts';

type Endpoint = { port: number; token: string };
export type CopilotDesktopFrame = { type: string; [key: string]: unknown };
const Frame = z.looseObject({ type: z.string() });
const runPrefixes = ['ws.release', 'ws'];

export function copilotDesktopControlAvailable(home: string) {
  return (
    process.platform !== 'win32' &&
    runPrefixes.some(
      (prefix) =>
        existsSync(join(home, '.copilot', 'run', `${prefix}.port`)) &&
        existsSync(join(home, '.copilot', 'run', `${prefix}.token`))
    )
  );
}

function readRunFile(path: string): string[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) return [];
    const bytes = Buffer.alloc(257);
    const size = readSync(fd, bytes);
    return size < bytes.length ? bytes.toString('utf8', 0, size).trim().split(/\r?\n/) : [];
  } finally {
    closeSync(fd);
  }
}

export function readCopilotDesktopEndpoint(home: string): Endpoint | null {
  if (process.platform === 'win32') return null;
  const directory = join(home, '.copilot', 'run');
  for (const prefix of runPrefixes) {
    try {
      const [portText, pidText] = readRunFile(join(directory, `${prefix}.port`));
      const port = Number(portText);
      const pid = Number(pidText);
      if (
        !(
          Number.isInteger(port) &&
          port >= 1024 &&
          port <= 65535 &&
          Number.isSafeInteger(pid) &&
          pid > 1
        )
      )
        continue;
      const [token, tokenPid] = readRunFile(join(directory, `${prefix}.token`));
      if (
        !token ||
        (tokenPid !== undefined && tokenPid !== pidText) ||
        !/^[\w-]{32,128}$/.test(token)
      )
        continue;
      process.kill(pid, 0);
      return { port, token };
    } catch {}
  }
  return null;
}

export function callCopilotDesktop<T>(
  endpoint: Endpoint,
  request: CopilotDesktopFrame,
  accept: (frame: CopilotDesktopFrame) => T | undefined,
  timeoutMs = 15_000
): Promise<Result<T>> {
  return new Promise((resolve) => {
    const url = new URL(`ws://127.0.0.1:${endpoint.port}/`);
    url.searchParams.set('token', endpoint.token);
    const ws = new WebSocket(url, {
      headers: { 'User-Agent': 'HyperNeo/CopilotDesktop' },
      followRedirects: false,
      maxPayload: 16 << 20,
      handshakeTimeout: 1500,
    });
    let sent = false;
    let settled = false;
    const timer = setTimeout(unreachable, timeoutMs);
    function finish(outcome: Result<T>) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(outcome);
    }
    function unreachable() {
      finish(
        sent
          ? reject(
              'unreachable',
              'Copilot Desktop did not confirm the operation. Do not replay it.'
            )
          : reject('unreachable', 'Copilot Desktop did not accept a local connection.', true)
      );
    }
    ws.once('open', () => {
      sent = true;
      ws.send(JSON.stringify(request), (error) => {
        if (error) unreachable();
      });
    });
    ws.on('error', unreachable);
    ws.once('close', unreachable);
    ws.on('message', (data) => {
      try {
        const frame = Frame.safeParse(JSON.parse(data.toString()));
        if (!frame.success) return;
        if (
          frame.data.type === 'session_message_delivery_unknown' &&
          frame.data.session_id === request.session_id
        ) {
          unreachable();
          return;
        }
        if (frame.data.type === 'error') {
          finish(reject('not_delivered', 'Copilot Desktop refused the operation.'));
          return;
        }
        const value = accept(frame.data);
        if (value !== undefined) finish({ ok: true, value });
      } catch {
        unreachable();
      }
    });
  });
}
