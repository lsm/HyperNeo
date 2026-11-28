import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  antigravityDesktopControlAvailable,
  readAntigravityDesktopEndpoint,
} from '../../../../src/lib/drivers/antigravity-desktop-channel';
import { createAntigravityDesktopControl } from '../../../../src/lib/drivers/antigravity-desktop-control';
import { createAntigravityDesktopDiscovery } from '../../../../src/lib/drivers/antigravity-desktop-discovery';

const TOKEN = 'csrf-token-0123456789abcdef';
const ID = 'conversation-1';
const cleanups: (() => Promise<void>)[] = [];
type Call = { method: string; token: unknown; body: Record<string, unknown> };
type Step = { type: string; status: string; userInput?: { userResponse: string } };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const user = (text: string): Step => ({
  type: 'CORTEX_STEP_TYPE_USER_INPUT',
  status: 'CORTEX_STEP_STATUS_DONE',
  userInput: { userResponse: text },
});
const reply = (status = 'CORTEX_STEP_STATUS_DONE'): Step => ({
  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  status,
});

async function app(
  options: { steps?: Step[]; echo?: boolean; sendStatus?: number; mode?: number } = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'antigravity-desktop-'));
  const calls: Call[] = [];
  const steps = options.steps ?? [user('hi'), reply()];
  const server = createServer(async (request: IncomingMessage, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    const method = request.url!.split('/').at(-1)!;
    calls.push({ method, token: request.headers['x-codeium-csrf-token'], body });
    if (request.headers['x-codeium-csrf-token'] !== TOKEN) {
      response.writeHead(401).end('{"code":"unauthenticated"}');
      return;
    }
    if (method === 'SendUserCascadeMessage' && options.echo !== false) {
      const items = body.items as { text: string }[];
      steps.push(user(items[0].text));
    }
    response
      .writeHead(method === 'SendUserCascadeMessage' ? (options.sendStatus ?? 200) : 200, {
        'content-type': 'application/json',
      })
      .end(JSON.stringify(method === 'GetCascadeTrajectorySteps' ? { steps } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const directory = join(home, '.gemini', 'antigravity', 'daemon');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `hub_${port}.json`);
  writeFileSync(file, JSON.stringify({ pid: process.pid, httpPort: port, csrfToken: TOKEN }));
  chmodSync(file, options.mode ?? 0o600);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const session = { id: ID, title: 'Probe', updatedAt: 1 };
  const adapter = createAntigravityDesktopDiscovery(
    async (query) => (query.id === ID ? [session] : []),
    'mini6',
    { homeDir: home, available: () => antigravityDesktopControlAvailable(home) }
  );
  return { home, port, calls, steps, adapter, directory };
}

const context = {} as never;

describe('readAntigravityDesktopEndpoint', () => {
  test('reads the private advertisement of the app listening on its port', async () => {
    const { home, port } = await app();
    expect(readAntigravityDesktopEndpoint(home)).toEqual({
      pid: process.pid,
      httpPort: port,
      csrfToken: TOKEN,
    });
  });

  test('ignores an advertisement others can read, or one whose port nobody owns', async () => {
    const shared = await app({ mode: 0o644 });
    expect(readAntigravityDesktopEndpoint(shared.home)).toBeNull();
    const stale = await app();
    writeFileSync(
      join(stale.directory, `hub_${stale.port}.json`),
      JSON.stringify({ pid: 999_999, httpPort: stale.port, csrfToken: TOKEN })
    );
    expect(readAntigravityDesktopEndpoint(stale.home)).toBeNull();
    expect(stale.adapter.capabilities).toEqual(['find']);
  });
});

describe('createAntigravityDesktopDiscovery send', () => {
  test('sends with the CSRF token and confirms the new user step', async () => {
    const { adapter, calls } = await app();
    expect(adapter.capabilities).toEqual(['find', 'send']);
    const result = await adapter.send!({ adapter: 'antigravity-desktop', id: ID }, 'go', context);
    expect(result.ok && result.value.delivered).toBe(true);
    const sent = calls.find((call) => call.method === 'SendUserCascadeMessage')!;
    expect(sent.token).toBe(TOKEN);
    expect(sent.body).toMatchObject({ cascadeId: ID, items: [{ text: 'go' }] });
    expect(result.ok && result.value.receipt).toEqual({
      executionId: ID,
      inputId: sent.body.clientMessageId as string,
    });
  });

  test('reports an accepted send it cannot see yet as unconfirmed', async () => {
    const { home } = await app({ echo: false });
    let clock = 0;
    const { send } = createAntigravityDesktopControl({
      homeDir: home,
      find: async () => ({ id: ID, title: 'Probe', updatedAt: 1 }),
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    });
    const result = await send({ adapter: 'antigravity-desktop', id: ID }, 'go', context);
    expect(result).toMatchObject({ ok: true, value: { delivered: false, unconfirmed: true } });
    expect(clock).toBeGreaterThanOrEqual(5_000);
  });

  test('refuses a busy conversation, an unknown id or a missing app without sending', async () => {
    const busy = await app({ steps: [user('hi'), reply('CORTEX_STEP_STATUS_GENERATING')] });
    expect(
      await busy.adapter.send!({ adapter: 'antigravity-desktop', id: ID }, 'go', context)
    ).toMatchObject({ ok: false, reason: 'busy', notSent: true });
    expect(
      await busy.adapter.send!({ adapter: 'antigravity-desktop', id: 'other' }, 'go', context)
    ).toMatchObject({ ok: false, reason: 'not_found', notSent: true });
    expect(busy.calls.some((call) => call.method === 'SendUserCascadeMessage')).toBe(false);
    rmSync(join(busy.directory, `hub_${busy.port}.json`));
    expect(
      await busy.adapter.send!({ adapter: 'antigravity-desktop', id: ID }, 'go', context)
    ).toMatchObject({ ok: false, reason: 'unreachable', notSent: true });
    expect(busy.adapter.capabilities).toEqual(['find']);
  });

  test('keeps the client id when the app rejects the send', async () => {
    const { adapter, calls } = await app({ sendStatus: 500 });
    const result = await adapter.send!({ adapter: 'antigravity-desktop', id: ID }, 'go', context);
    const sent = calls.find((call) => call.method === 'SendUserCascadeMessage')!;
    expect(result).toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'Antigravity Desktop rejected SendUserCascadeMessage (500).',
      clientMessageId: sent.body.clientMessageId as string,
    });
  });
});
