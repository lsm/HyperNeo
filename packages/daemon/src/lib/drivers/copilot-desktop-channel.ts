import { execFileSync } from 'node:child_process';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Result } from './types.ts';
import { reject } from './work-operations.ts';

type Endpoint = { port: number; pid: number; token: string };
export type CopilotDesktopFrame = { type: string; [key: string]: unknown };
const Frame = z.looseObject({ type: z.string() });
const runPrefixes = ['ws.release', 'ws'];

function privateFile(info: Stats) {
  return info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
}

function readRunFile(path: string): string[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!privateFile(info)) return [];
    const bytes = Buffer.alloc(257);
    const size = readSync(fd, bytes);
    return size < bytes.length ? bytes.toString('utf8', 0, size).trim().split(/\r?\n/) : [];
  } finally {
    closeSync(fd);
  }
}

function ownsListener(port: number, pid: number) {
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof';
  try {
    const owners = execFileSync(
      lsof,
      ['-nP', '-a', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'],
      {
        encoding: 'utf8',
        timeout: 500,
        maxBuffer: 4096,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const processes = owners.split('\n').filter((line) => line.startsWith('p'));
    return processes.length === 1 && processes[0] === `p${pid}`;
  } catch {
    return false;
  }
}

function* desktopAdvertisements(home: string) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
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
      const tokenPath = join(directory, `${prefix}.token`);
      if (privateFile(lstatSync(tokenPath)) && ownsListener(port, pid)) {
        yield { port, pid, tokenPath };
      }
    } catch {}
  }
}

export function copilotDesktopControlAvailable(home: string) {
  return !desktopAdvertisements(home).next().done;
}

export function readCopilotDesktopEndpoint(home: string): Endpoint | null {
  for (const { port, pid, tokenPath } of desktopAdvertisements(home)) {
    try {
      const [token, tokenPid] = readRunFile(tokenPath);
      if (
        token &&
        (tokenPid === undefined || Number(tokenPid) === pid) &&
        /^[\w-]{32,128}$/.test(token)
      )
        return { port, pid, token };
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
  if (!ownsListener(endpoint.port, endpoint.pid))
    return Promise.resolve(
      reject('unreachable', 'Copilot Desktop no longer owns its local port.', true)
    );
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
          if (
            request.type === 'create_repository_from_path' &&
            frame.data.request_id === undefined &&
            frame.data.session_id === undefined &&
            typeof frame.data.message === 'string' &&
            frame.data.message.startsWith(
              'Invalid message format: unknown variant `create_repository_from_path`, expected '
            )
          ) {
            finish(
              reject('unsupported', 'Copilot Desktop does not support repository creation.', true)
            );
            return;
          }
          if (
            typeof request.request_id === 'string' &&
            frame.data.request_id === request.request_id &&
            (frame.data.session_id === undefined || frame.data.session_id === request.session_id)
          ) {
            finish(reject('not_delivered', 'Copilot Desktop refused the operation.'));
          } else unreachable();
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
