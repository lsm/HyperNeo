import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  installClaudeNativeWrites,
  readClaudeWorkerSandbox,
} from '../../../../src/lib/drivers/claude-native-writes.ts';
import {
  codexWorkerSandbox,
  configureWorkerSockets,
} from '../../../../src/lib/drivers/worker-sandbox.ts';

vi.mock('../../../../src/lib/drivers/worker-sandbox.ts', async (original) => {
  const actual = await original<typeof import('../../../../src/lib/drivers/worker-sandbox.ts')>();
  return { ...actual, prepareWorkerSandbox: vi.fn(async () => ({})) };
});

const fixture = mkdtempSync(join(tmpdir(), 'worker-sockets-'));
const root = join(fixture, 'worker');
const allowed = join(fixture, 'approved-agent.sock');
const denied = join(fixture, 'unapproved-db.sock');
mkdirSync(join(root, '.git/info'), { recursive: true });
afterEach(() => configureWorkerSockets(() => []));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

test('new Claude worker policy grants only the human-approved socket', async () => {
  configureWorkerSockets(() => [allowed]);
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'));
  expect(settings.sandbox.network.allowUnixSockets).toEqual([allowed]);
  expect(settings.sandbox.network.allowUnixSockets).not.toContain(denied);
  expect(settings.sandbox.network.allowAllUnixSockets).toBe(false);
  let sockets = [allowed];
  configureWorkerSockets(() => sockets);
  expect((await readClaudeWorkerSandbox(root))?.sandbox.network.allowUnixSockets).toEqual([
    allowed,
  ]);
  sockets = [];
  expect((await readClaudeWorkerSandbox(root))?.sandbox.network.allowUnixSockets).toEqual([]);
  expect(
    JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8')).sandbox.network
      .allowUnixSockets
  ).toEqual([]);
});

test('new Codex worker policy grants only the human-approved socket', () => {
  let sockets = [allowed];
  configureWorkerSockets(() => sockets);
  const policy = codexWorkerSandbox(root).config.features.network_proxy;
  expect(policy.unix_sockets).toEqual({ [allowed]: 'allow' });
  expect(policy.unix_sockets[denied]).toBeUndefined();
  expect(policy.dangerously_allow_all_unix_sockets).toBe(false);
  sockets = [];
  expect(codexWorkerSandbox(root).config.features.network_proxy.unix_sockets).toEqual({});
});
