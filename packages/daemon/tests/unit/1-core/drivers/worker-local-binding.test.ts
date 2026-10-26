import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installClaudeNativeWrites,
  readClaudeWorkerSandbox,
} from '../../../../src/lib/drivers/claude-native-writes.ts';
import {
  codexWorkerSandbox,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox.ts';

let fixture: string;
let root: string;
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'worker-loopback-'));
  root = join(fixture, 'worker');
  mkdirSync(join(root, '.git/info'), { recursive: true });
});
afterEach(() => {
  rmSync(join(workerSandboxPaths(root).TMPDIR, '..'), { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

const settings = () => JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8'));

test('written Claude worker settings permit sandboxed local servers', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  expect(settings().sandbox.network.allowLocalBinding).toBe(true);
});

test('resuming an older worker persists local listening without replacing its network choices', async () => {
  await installClaudeNativeWrites(root, [join(root, 'source')]);
  const old = settings();
  delete old.sandbox.network.allowLocalBinding;
  old.sandbox.network.allowedDomains = ['synthetic.invalid'];
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(old));
  await readClaudeWorkerSandbox(root);
  expect(settings().sandbox.network).toEqual({ ...old.sandbox.network, allowLocalBinding: true });
  expect(settings().permissions).toEqual(old.permissions);
});

test('both Codex policy shapes enable network access for local servers', () => {
  const policy = codexWorkerSandbox(root);
  expect(policy.config.sandbox_workspace_write.network_access).toBe(true);
  expect(policy.sandboxPolicy.networkAccess).toBe(true);
});
