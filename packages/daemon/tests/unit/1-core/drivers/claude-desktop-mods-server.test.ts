import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { lstat, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createClaudeDesktopModsServer } from '../../../../src/lib/drivers/claude-desktop-mods-server';
import { register } from '../../../../claude-desktop-bridge/hooks/register';

type Deps = Parameters<typeof createClaudeDesktopModsServer>[0];
type Exchange = Parameters<Deps['persist']>[0];
type Reply = Awaited<ReturnType<Deps['persist']>>;
const sessionId = '3b286924-739c-487d-82d2-c3e36fd5ed36';
const instanceId = `${sessionId}:1234:1`;
const live = { sessionId, pid: 456, owner: 'desktop' as const, status: 'busy' };
const registration = {
  sessionId,
  pid: 456,
  procStart: 'Thu Oct 15 15:18:31 2026',
  entrypoint: 'claude-desktop',
  version: '2.1.299',
  peerProtocol: 1,
  peerFeatures: ['notify_idle'],
  messagingSocketPath: '/tmp/cc-socks/456.sock',
};
const frame: Exchange = {
  version: 1,
  sessionId,
  instanceId,
  events: [{ sequence: 1, kind: 'session.start' }],
};

describe('Claude Desktop mods transport', () => {
  let dir: string;
  let deps: Deps;
  let server: Awaited<ReturnType<typeof createClaudeDesktopModsServer>>;
  let socketPath: string;
  let token: string;
  let saved: Array<{ exchange: Exchange; pid: number }>;
  let errors: unknown[];

  beforeEach(async () => {
    dir = await mkdtemp('/tmp/hnm-');
    await writeFile(join(dir, '456.json'), JSON.stringify(registration));
    saved = [];
    errors = [];
    deps = {
      parentDirectory: dir,
      registrationsDir: dir,
      liveSessions: async () => [live],
      persist: async (exchange, pid) => {
        saved.push({ exchange, pid });
        return { ack: exchange.events.at(-1)?.sequence ?? 1 };
      },
      onError: (error) => void errors.push(error),
    };
    server = await createClaudeDesktopModsServer(deps);
    ({ socketPath, token } = JSON.parse(await readFile(server.connectionFile, 'utf8')));
  });
  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  function send(
    body: unknown = frame,
    headers: Record<string, string> = {},
    method = 'POST',
    path = '/bridge/exchange'
  ) {
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path,
          method,
          agent: false,
          headers: { authorization: `Bearer ${token}`, ...headers },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.once('end', () => resolve({ status: res.statusCode!, text }));
          res.once('error', reject);
        }
      );
      req.once('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('test request timed out')));
      req.end(
        method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      );
    });
  }

  test('creates only private owned files and removes them idempotently on close', async () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (const path of [dirname(socketPath), socketPath, server.connectionFile]) {
      const info = await lstat(path);
      expect(info.uid).toBe(process.getuid!());
      expect(info.mode & 0o077).toBe(0);
    }
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await server.close();
    await server.close();
    await expect(lstat(dirname(socketPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('persists facts for the freshly verified Desktop PID before returning its ACK', async () => {
    expect(await send()).toEqual({ status: 200, text: '{"ack":1}' });
    expect(saved).toEqual([{ exchange: frame, pid: 456 }]);
    expect(errors).toEqual([]);
    expect(await send({ ...frame, events: [] })).toEqual({ status: 200, text: '{"ack":1}' });
  });

  test.each([
    { id: 'stop-1', instanceId, kind: 'stop', turnId: 'turn-1' },
    { id: 'input-1', instanceId, kind: 'submit', from: 'session:neo', text: 'peer\n"message"' },
  ] as const)(
    'returns the persisted instance-bound %j command without inventing a receipt',
    async (command) => {
      deps.persist = async () => ({ ack: 1, command });
      const response = await send();
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({ ack: 1, command });
      expect(response.text).not.toContain('delivered');
    }
  );

  test.each(['', 'Bearer wrong', 'Basic abc', `Bearer ${'x'.repeat(64)}`])(
    'rejects unauthorized %s before owner discovery or persistence',
    async (authorization) => {
      deps.liveSessions = async () => {
        throw new Error('must not discover');
      };
      expect(await send(frame, { authorization })).toEqual({ status: 401, text: '' });
      expect(saved).toEqual([]);
      expect(errors).toEqual([]);
    }
  );

  test.each([
    ['GET', '/bridge/exchange'],
    ['POST', '/private'],
  ])('rejects route %s %s', async (method, path) => {
    expect((await send(frame, {}, method, path)).status).toBe(404);
    expect(saved).toEqual([]);
  });

  test.each([
    '{',
    'null',
    '{}',
    JSON.stringify({ ...frame, version: 2 }),
    JSON.stringify({ ...frame, instanceId: 'other-session:1' }),
    JSON.stringify({ ...frame, events: [{ sequence: 1, kind: 'turn.start' }] }),
    JSON.stringify({ ...frame, events: [{ sequence: 1, kind: 'command.resolved' }] }),
    JSON.stringify({
      ...frame,
      events: [
        { sequence: 1, kind: 'session.start' },
        { sequence: 3, kind: 'session.end' },
      ],
    }),
  ])('rejects malformed lifecycle input %s before persistence', async (body) => {
    expect((await send(body)).status).toBe(400);
    expect(saved).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('bounds request memory and refuses oversized bodies without touching persistence', async () => {
    expect((await send('x'.repeat(1_048_577))).status).toBe(413);
    expect(saved).toEqual([]);
    expect(errors).toEqual([]);
  });

  test.each(['cli', 'unknown', 'missing', 'ambiguous', 'stale-registration'] as const)(
    'refuses %s ownership before persisting a command exchange',
    async (kind) => {
      if (kind === 'cli') {
        deps.liveSessions = async () => [{ ...live, owner: 'cli' }];
        await writeFile(
          join(dir, '456.json'),
          JSON.stringify({ ...registration, entrypoint: 'cli', version: '2.1.295' })
        );
      } else if (kind === 'unknown')
        deps.liveSessions = async () => [{ ...live, owner: 'unknown' }];
      else if (kind === 'missing') deps.liveSessions = async () => [];
      else if (kind === 'ambiguous') deps.liveSessions = async () => [live, { ...live, pid: 457 }];
      else
        await writeFile(
          join(dir, '456.json'),
          JSON.stringify({ ...registration, entrypoint: 'cli' })
        );
      expect((await send()).status).toBe(409);
      expect(saved).toEqual([]);
    }
  );

  test('rechecks the registered endpoint on each request', async () => {
    expect((await send()).status).toBe(200);
    await unlink(join(dir, '456.json'));
    expect((await send()).status).toBe(409);
    expect(saved).toHaveLength(1);
  });

  test.each([
    { ack: 2 },
    { ack: -1 },
    { ack: 1, command: { id: 'wrong', instanceId: 'old', kind: 'stop', turnId: 'turn' } },
    { ack: 1, command: { id: 'native', instanceId, kind: 'withdraw', messageId: 'native-queue' } },
  ])('does not acknowledge invalid persistence response %j', async (reply) => {
    deps.persist = async () => reply as Reply;
    expect(await send()).toEqual({ status: 500, text: '' });
    expect(errors).toHaveLength(1);
  });

  test('does not acknowledge a failed persistence transaction', async () => {
    deps.persist = async () => {
      throw new Error('database write failed');
    };
    expect(await send()).toEqual({ status: 500, text: '' });
    expect(errors.map(String)).toEqual(['Error: database write failed']);
  });

  test('the shipped mods client executes stop and quoted next-turn input through the socket', async () => {
    type Hook = Parameters<Parameters<typeof register>[0]>[1];
    const hooks = new Map<string, Hook>();
    const stopped: string[] = [];
    const submitted: string[] = [];
    let operation = 'stop';
    deps.persist = async (exchange, pid) => {
      saved.push({ exchange, pid });
      const command =
        operation === 'stop'
          ? {
              id: 'stop',
              instanceId: exchange.instanceId,
              kind: 'stop' as const,
              turnId: 'turn-live',
            }
          : {
              id: 'submit',
              instanceId: exchange.instanceId,
              kind: 'submit' as const,
              from: 'session:neo',
              text: 'next question',
            };
      return { ack: exchange.events.at(-1)?.sequence ?? 0, command };
    };
    const api: Parameters<Hook>[0] = {
      fs: { read: (path) => readFile(path, 'utf8') },
      session: { id: async () => sessionId },
      clock: { now: async () => 1234, every: () => ({ cancel: () => {} }) },
      http: {
        fetch: async (_url, init) => {
          expect(init.socketPath).toBe(socketPath);
          const response = await send(init.body, init.headers);
          return { ok: response.status === 200, text: response.text };
        },
      },
      turn: {
        abort: async ({ turnId }) => {
          stopped.push(turnId);
        },
      },
      prompt: {
        submit: async ({ text }) => {
          submitted.push(text);
        },
      },
    };
    register((event, hook) => void hooks.set(event, hook), {
      enabled: true,
      connectionFile: server.connectionFile,
    });
    const next = async () => ({});
    await hooks.get('session.start')!(api, {}, next);
    expect(stopped).toEqual(['turn-live']);
    operation = 'submit';
    await hooks.get('turn.complete')!(
      api,
      { turnId: 'turn-live', reason: 'aborted', isAborted: true },
      next
    );
    expect(submitted).toEqual([
      'Peer input via HyperNeo plugin (not human approval):\n{"from":"session:neo","text":"next question"}',
    ]);
    await hooks.get('session.end')!(api, { reason: 'other' }, next);
    expect(submitted).toHaveLength(1);
    expect(saved.at(-1)!.exchange.events).toContainEqual({
      sequence: 6,
      kind: 'command.resolved',
      commandId: 'submit',
    });
    expect(saved.at(-1)!.exchange.events.at(-1)).toMatchObject({ kind: 'session.end' });
    expect(errors).toEqual([]);
  });

  test('drains pending persistence during shutdown', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (reply: Reply) => void;
    deps.persist = async () => {
      started();
      return new Promise<Reply>((resolve) => {
        release = resolve;
      });
    };
    const response = send().catch(() => undefined);
    await entered;
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release({ ack: 1 });
    await closing;
    await response;
    expect(closed).toBe(true);
    await expect(lstat(server.connectionFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('cleanup preserves an endpoint that replaced the published socket', async () => {
    await unlink(socketPath);
    const replacement = createServer();
    await new Promise<void>((resolve) => replacement.listen(socketPath, resolve));
    try {
      await expect(server.close()).rejects.toMatchObject({ code: 'ENOTEMPTY' });
      expect((await lstat(socketPath)).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
      await rm(dirname(socketPath), { recursive: true, force: true });
      server = { connectionFile: '', close: async () => {} };
    }
  });

  test('cleanup preserves a replacement connection file', async () => {
    await rename(server.connectionFile, `${server.connectionFile}.original`);
    await writeFile(server.connectionFile, 'replacement', { mode: 0o600 });
    await expect(server.close()).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(await readFile(server.connectionFile, 'utf8')).toBe('replacement');
    await rm(dirname(socketPath), { recursive: true, force: true });
    server = { connectionFile: '', close: async () => {} };
  });
});
