import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { checkOxapBinary } from '../../../packages/daemon/src/lib/oxap/oxap-binary.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport, type Session } from '../../../packages/shared/src/mod.ts';
import { answerCodexProbeLocally, OXAP_CODEX_MODEL, oxapCodexProvider, serveLocalRelease } from './oxap-codex-provider.ts';

const [binary, version, sha256, runArgument] = process.argv.slice(2);
const run = resolve(runArgument);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.deepEqual(await checkOxapBinary(binary, { version, sha256 }), { ok: true });
const workspacePath = join(run, 'workspace');
const executable = join(run, 'adapter');
const adapterHelp = `#!/bin/sh
case "$*" in
  "app-server --help") echo 'Usage: codex app-server [OPTIONS]' ;;
  "--help") echo 'Usage: dsh [--profile] <name>' ;;
  *) exit 1 ;;
esac
`;
mkdirSync(workspacePath);
mkdirSync(join(run, 'evidence'));
writeFileSync(executable, adapterHelp, { mode: 0o700 });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
answerCodexProbeLocally();
const downloads = serveLocalRelease(binary, version, join(run, 'release'));
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: workspacePath }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: createLocalSocket,
});
const codex = { provider: 'anthropic-codex', model: OXAP_CODEX_MODEL };
const deepseek = { provider: 'deepseek', model: 'deepseek-v4-pro' };
const evidence: { creations: string[]; refusals: string[]; clones: string[]; cloneRefusals: string[] } = {
  creations: [], refusals: [], clones: [], cloneRefusals: [],
};

try {
  await app.jobProcessor.stop();
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', { params: { ...oxapCodexProvider.params, configJson: '{}' } });
  const { provider } = await hub.request<{ provider: { id: string } }>('providers.create', {
    params: {
      providerId: deepseek.provider, displayName: 'Synthetic DeepSeek', kind: 'built_in',
      authType: 'api_key', isEnabled: true, isDefault: false, sortOrder: 2,
    },
  });
  const save = async (providerId: string, harness: string, settings?: { executable: string }) => {
    assert.deepEqual(await hub.request('operation.invoke', {
      name: 'oxap.settings.save', input: { providerId, harness, settings },
    }), { accepted: true });
  };
  const create = (title: string, config: object, harness?: string) =>
    hub.request<{ sessionId: string; session: Session }>('session.create', {
      workspacePath, title, config, ...(harness === undefined ? {} : { harness }),
    });
  const expectEngine = async (title: string, config: object, expected: string | undefined, harness?: string) => {
    const { sessionId, session } = await create(title, config, harness);
    assert.equal(session.config.harness, expected, title);
    assert.equal(app.db.getSession(sessionId)?.config.harness, expected, title);
    evidence.creations.push(title);
    return sessionId;
  };
  const refuse = async (title: string, config: object, harness: string | undefined, reason: RegExp) => {
    const count = app.db.listSessions().length;
    await assert.rejects(create(title, config, harness), reason);
    assert.equal(app.db.listSessions().length, count, title);
    evidence.refusals.push(title);
  };
  const clone = async (parentSessionId: string, expected: string | undefined) => {
    const child = await hub.request<{ accepted: boolean; sessionId: string }>('operation.invoke', {
      name: 'session.clone.spawn', input: { parentSessionId, title: 'Synthetic clone' },
    });
    assert(child.accepted);
    const { session } = await hub.request<{ session: Session }>('session.get', { sessionId: child.sessionId });
    assert.equal(session.config.harness, expected);
    assert.equal(session.parentSessionId, parentSessionId);
    evidence.clones.push(expected ?? 'sdk');
  };

  await save(codex.provider, 'oxap-codex', { executable });
  const oxap = await expectEngine('OXAP provider default', codex, 'oxap-codex');
  const sdk = await expectEngine('Explicit SDK override', codex, undefined, 'sdk');
  await clone(sdk, undefined);

  await save(codex.provider, 'sdk');
  await expectEngine('SDK provider default', codex, undefined);
  await expectEngine('Explicit OXAP override', codex, 'oxap-codex', 'oxap-codex');
  await clone(oxap, 'oxap-codex');
  await refuse('Wrong provider', codex, 'oxap-deepseek', /cannot run on oxap-deepseek/);
  await refuse('Unknown harness', codex, 'unknown', /Unknown session harness/);
  await refuse('Nested harness', { ...codex, harness: 'oxap-codex' }, undefined, /harness/);
  await refuse('Unpublished OXAP thinking', { ...codex, thinkingLevel: 'think16k' }, 'oxap-codex', /does not publish support for this thinking level/);
  await refuse('Explicit OXAP restriction', { ...codex, permissionMode: 'plan' }, 'oxap-codex', /this restriction is not supported/);

  await refuse('Missing executable settings', deepseek, 'oxap-deepseek', /needs an absolute executable path/);
  await save(deepseek.provider, 'oxap-deepseek', { executable });
  await refuse('Missing stored key', deepseek, 'oxap-deepseek', /DEEPSEEK_API_KEY/);
  await refuse('Missing key on provider default', deepseek, undefined, /DEEPSEEK_API_KEY/);
  const updated = await hub.request<{ success: boolean }>('providers.update', {
    id: provider.id, params: {}, credentials: { apiKey: 'synthetic-admission-only' },
  });
  assert(updated.success);
  await expectEngine('DeepSeek with stored key', deepseek, 'oxap-deepseek');

  unlinkSync(executable);
  await refuse('Executable removed', codex, 'oxap-codex', /needs an executable file/);
  const beforeClone = app.db.listSessions().length;
  const rejectedClone = await hub.request('operation.invoke', {
    name: 'session.clone.spawn', input: { parentSessionId: oxap, title: 'Refused clone' },
  });
  assert.deepEqual(rejectedClone, {
    accepted: false,
    reason: 'harness_unsupported',
    message: 'anthropic-codex needs an executable file; check Settings → Providers',
  });
  assert.equal(app.db.listSessions().length, beforeClone);
  evidence.cloneRefusals.push('Executable removed');
  writeFileSync(executable, adapterHelp, { mode: 0o700 });
  unlinkSync(app.settingsManager.getGlobalSettings().oxapHub!.path);
  await refuse('Installed hub removed', codex, 'oxap-codex', /OXAP hub is not installed/);
  assert.deepEqual(downloads, ['SHA256SUMS.txt', `${version}.tar.gz`]);
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
