import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { createClaudeDesktopModsRuntime } from '../../../../src/lib/drivers/claude-desktop-mods-runtime';
import { createTables } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

type Deps = Parameters<typeof createClaudeDesktopModsRuntime>[0];
type Runtime = NonNullable<Awaited<ReturnType<typeof createClaudeDesktopModsRuntime>>>;
const sessionId = '3b286924-739c-487d-82d2-c3e36fd5ed36';
const instanceId = `${sessionId}:1234:1`;
const from = 'session:neo';
const live = { sessionId, pid: 456, owner: 'desktop' as const, status: 'idle' };
const frame = {
  version: 1,
  sessionId,
  instanceId,
  events: [{ sequence: 1, kind: 'session.start' }],
};

describe('Claude Desktop mods runtime', () => {
  let dir: string;
  let db: Database;
  let deps: Deps;
  let file: string;
  let runtime: Runtime | undefined;
  let errors: unknown[];
  beforeEach(async () => {
    dir = await mkdtemp('/tmp/hnmr-');
    await chmod(dir, 0o700);
    file = join(dir, 'connection.json');
    db = new Database(join(dir, 'db.sqlite'));
    createTables(db);
    errors = [];
    deps = {
      db,
      env: {
        HYPERNEO_CLAUDE_DESKTOP_MODS: '1',
        HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE: file,
      },
      registrationsDir: dir,
      socketDirectory: dir,
      liveSessions: async () => [live],
      onError: (error) => void errors.push(error),
    };
    await writeFile(
      join(dir, '456.json'),
      JSON.stringify({
        sessionId,
        pid: 456,
        procStart: 'Thu Oct 15 15:18:31 2026',
        entrypoint: 'claude-desktop',
        version: '2.1.299',
        peerProtocol: 1,
        peerFeatures: ['notify_idle'],
        messagingSocketPath: '/tmp/cc-socks/456.sock',
      })
    );
  });
  afterEach(async () => {
    await runtime?.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function send(body: unknown = frame) {
    const config = JSON.parse(await readFile(file, 'utf8'));
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        {
          socketPath: config.socketPath,
          path: '/bridge/exchange',
          method: 'POST',
          agent: false,
          headers: { authorization: `Bearer ${config.token}` },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.once('end', () =>
            resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} })
          );
          res.once('error', reject);
        }
      );
      req.once('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('runtime test timeout')));
      req.end(JSON.stringify(body));
    });
  }

  test.each([undefined, '', '0', 'true'])(
    'flag %s leaves no listener, files or discovery',
    async (flag) => {
      deps.env.HYPERNEO_CLAUDE_DESKTOP_MODS = flag;
      deps.liveSessions = async () => {
        throw new Error('must not discover');
      };
      expect(await createClaudeDesktopModsRuntime(deps)).toBeUndefined();
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(`${file}.owner.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  test.each([undefined, '', 'relative.json'])(
    'requires an explicit absolute file: %s',
    async (path) => {
      deps.env.HYPERNEO_CLAUDE_DESKTOP_MODS_CONNECTION_FILE = path;
      await expect(createClaudeDesktopModsRuntime(deps)).rejects.toThrow('absolute');
    }
  );

  test('publishes a private stable pointer and cleans up idempotently', async () => {
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    const config = JSON.parse(await readFile(file, 'utf8'));
    expect(config.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(config.socketPath)).isSocket()).toBe(true);
    await runtime.close();
    await runtime.close();
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${file}.owner.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each(['directory', 'file', 'symlink'])(
    'refuses insecure %s without replacing it',
    async (kind) => {
      if (kind === 'directory') await chmod(dir, 0o755);
      else if (kind === 'file') await writeFile(file, 'untouched', { mode: 0o644 });
      else await symlink(join(dir, '456.json'), file);
      await expect(createClaudeDesktopModsRuntime(deps)).rejects.toThrow();
      if (kind === 'file') expect(await readFile(file, 'utf8')).toBe('untouched');
      if (kind === 'symlink') expect((await lstat(file)).isSymbolicLink()).toBe(true);
    }
  );

  test('does not overwrite a concurrent runtime', async () => {
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    const before = await readFile(file, 'utf8');
    await expect(createClaudeDesktopModsRuntime(deps)).rejects.toThrow('already active');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await send()).status).toBe(200);
  });

  test('refuses another live process lock and retains its connection file', async () => {
    await writeFile(`${file}.owner.lock`, String(process.ppid));
    await writeFile(file, 'other daemon', { mode: 0o600 });
    await expect(createClaudeDesktopModsRuntime(deps)).rejects.toThrow('Another HyperNeo');
    expect(await readFile(file, 'utf8')).toBe('other daemon');
    expect(await readFile(`${file}.owner.lock`, 'utf8')).toBe(String(process.ppid));
  });

  test('preserves a replacement pointer on shutdown', async () => {
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    await writeFile(`${file}.replacement`, 'replacement');
    await rename(`${file}.replacement`, file);
    await runtime.close();
    expect(await readFile(file, 'utf8')).toBe('replacement');
  });

  test('reclaims a dead daemon lock using the existing lock protocol', async () => {
    await writeFile(`${file}.owner.lock`, '2147483647');
    await writeFile(file, 'stale pointer', { mode: 0o600 });
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    expect(await readFile(`${file}.owner.lock`, 'utf8')).toBe(String(process.pid));
    expect((await send()).status).toBe(200);
  });

  test('releases publication ownership when server startup fails', async () => {
    deps.socketDirectory = join(dir, 'missing');
    await expect(createClaudeDesktopModsRuntime(deps)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${file}.owner.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    deps.socketDirectory = dir;
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    expect((await send()).status).toBe(200);
  });

  test.each(['idle', 'busy'])(
    'uses the same verified owner %s fact to bootstrap dispatch',
    async (status) => {
      deps.liveSessions = async () => [{ ...live, status }];
      runtime = (await createClaudeDesktopModsRuntime(deps))!;
      const job = runtime.outbox.enqueue(sessionId, from, { kind: 'submit', text: 'next' });
      const reply = await send();
      expect(reply.status).toBe(200);
      expect(reply.body.ack).toBe(1);
      expect(runtime.outbox.get(sessionId, from, job.id)?.status).toBe(
        status === 'idle' ? 'processing' : 'pending'
      );
      expect(!!reply.body.command).toBe(status === 'idle');
    }
  );

  test('notifies after commit and retries failed durable reporting before ACK', async () => {
    let calls = 0;
    deps.onExchange = async () => {
      expect(runtime!.outbox.journal.active(sessionId)?.sequence).toBe(1);
      if (++calls === 1) throw new Error('mailbox offline');
    };
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    const notified: string[] = [];
    const unsubscribe = runtime.subscribe((sid) => notified.push(sid));
    expect((await send()).status).toBe(500);
    expect(await send()).toEqual({ status: 200, body: { ack: 1 } });
    expect(notified).toEqual([sessionId, sessionId]);
    unsubscribe();
    await send({ ...frame, events: [] });
    expect(notified).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(runtime.outbox.journal.events(sessionId, instanceId)).toHaveLength(1);
  });

  test('restart republishes the same path and resumes the exact claimed command without replay', async () => {
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    const job = runtime.outbox.enqueue(sessionId, from, { kind: 'submit', text: 'once' });
    const first = await send();
    const config = await readFile(file, 'utf8');
    await runtime.close();
    db.close();
    db = new Database(join(dir, 'db.sqlite'));
    deps.db = db;
    runtime = (await createClaudeDesktopModsRuntime(deps))!;
    expect(await readFile(file, 'utf8')).not.toBe(config);
    const next = await send();
    expect(next.body.command).toEqual(first.body.command);
    expect(runtime.outbox.jobs.listJobs({})).toHaveLength(1);
    const receipt = await send({
      ...frame,
      events: [{ sequence: 2, kind: 'command.resolved', commandId: job.id, result: {} }],
    });
    expect(receipt).toEqual({ status: 200, body: { ack: 2 } });
    expect(runtime.outbox.get(sessionId, from, job.id)?.status).toBe('completed');
  });
});
