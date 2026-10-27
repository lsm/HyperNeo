import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  installClaudeNativeWrites,
  readClaudeWorkerSandbox,
} from '../../../../src/lib/drivers/claude-native-writes.ts';
import { codexWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox.ts';

vi.mock('../../../../src/lib/drivers/worker-sandbox.ts', async (original) => {
  const actual = await original<typeof import('../../../../src/lib/drivers/worker-sandbox.ts')>();
  return { ...actual, prepareWorkerSandbox: vi.fn(async () => ({})) };
});

const fixture = mkdtempSync(join(tmpdir(), 'worker-sockets-'));
const root = join(fixture, 'worker');
const settingsFile = join(root, '.claude/settings.local.json');
const settings = () => JSON.parse(readFileSync(settingsFile, 'utf8'));
mkdirSync(join(root, '.git/info'), { recursive: true });
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

test('a Claude worker may reach any Unix socket, and a resumed older worker is upgraded', async () => {
  await installClaudeNativeWrites(root, [join(fixture, 'source')]);
  expect(settings().sandbox.network.allowAllUnixSockets).toBe(true);
  const older = settings();
  older.sandbox.network.allowAllUnixSockets = false;
  writeFileSync(settingsFile, JSON.stringify(older));
  expect((await readClaudeWorkerSandbox(root))?.sandbox.network.allowAllUnixSockets).toBe(true);
  expect(settings().sandbox.network.allowAllUnixSockets).toBe(true);
  expect(settings().sandbox.filesystem).toEqual(older.sandbox.filesystem);
});

test('a Codex worker may reach any Unix socket and still binds locally', () => {
  const policy = codexWorkerSandbox(root).config.features.network_proxy;
  expect(policy.dangerously_allow_all_unix_sockets).toBe(true);
  expect(policy.allow_local_binding).toBe(true);
  const profile = codexWorkerSandbox(root).config.permissions['hyperneo-worker'].network;
  expect(profile.dangerously_allow_all_unix_sockets).toBe(true);
  expect(profile.allow_local_binding).toBe(true);
});
