import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { installClaudeNativeWrites } from '../../../../src/lib/drivers/claude-native-writes.ts';
import { codexWorkerSandbox } from '../../../../src/lib/drivers/worker-sandbox.ts';

vi.mock('../../../../src/lib/drivers/worker-sandbox.ts', async (original) => {
  const actual = await original<typeof import('../../../../src/lib/drivers/worker-sandbox.ts')>();
  return { ...actual, prepareWorkerSandbox: vi.fn(async () => ({})) };
});

const fixture = mkdtempSync(join(tmpdir(), 'worker-sockets-'));
const root = join(fixture, 'worker');
const allowed = join(fixture, 'approved-agent.sock');
const denied = join(fixture, 'unapproved-db.sock');
mkdirSync(join(root, '.git/info'), { recursive: true });
afterEach(() => rmSync(join(root, '.claude'), { recursive: true, force: true }));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

test('new Claude worker policy grants only the human-approved socket', async () => {
  await Reflect.apply(installClaudeNativeWrites, undefined, [root, [], [allowed]]);
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'));
  expect(settings.sandbox.network.allowUnixSockets).toEqual([allowed]);
  expect(settings.sandbox.network.allowUnixSockets).not.toContain(denied);
  expect(settings.sandbox.network.allowAllUnixSockets).toBe(false);
});

test('new Codex worker policy grants only the human-approved socket', () => {
  const policy = Reflect.apply(codexWorkerSandbox, undefined, [root, [allowed]]);
  expect(JSON.stringify(policy)).toContain(allowed);
  expect(JSON.stringify(policy)).not.toContain(denied);
});
