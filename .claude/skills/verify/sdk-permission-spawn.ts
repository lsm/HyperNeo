import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { query, type Options } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { QueryOptionsBuilder, type QueryOptionsBuilderContext } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { installClaudeNativeWrites } from '../../../packages/daemon/src/lib/drivers/claude-native-writes.ts';
import { workerSandboxPaths } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';
import { createFlagSettingsFileWriter } from '../../../packages/daemon/src/lib/agent/flag-settings-file.ts';

const mode = process.argv[2];
const run = resolve(process.argv[3]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
const cli = resolve(process.env.VERIFY_CLAUDE || 'node_modules/.bun/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
for (const name of ['home/.claude', 'ordinary', 'prepared/.git/info', 'protected', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const userSettings = join(run, 'home/.claude/settings.json');
const originalSettings = JSON.stringify({ permissions: { defaultMode: 'auto' } });
writeFileSync(userSettings, originalSettings);
await installClaudeNativeWrites(join(run, 'prepared'), [join(run, 'protected')]);
const children = new Set<ChildProcess>();
const sdkVersion = JSON.parse(readFileSync(resolve('packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;
const evidence: Record<string, unknown> = { pass: false, nativeSdk: true, sdkVersion, realProvider: false, cases: [] };
const writeFlags = createFlagSettingsFileWriter(join(run, 'tmp'));

async function built(prepared: boolean): Promise<Options> {
  const builder = new QueryOptionsBuilder({
    session: { id: crypto.randomUUID(), workspacePath: join(run, prepared ? 'prepared' : 'ordinary'), config: { provider: 'anthropic', model: 'haiku', permissionMode: 'bypassPermissions', pathToClaudeCodeExecutable: cli } },
    settingsManager: { prepareSDKOptions: async () => ({}), getGlobalSettings: () => ({ settingSources: ['user', 'project', 'local'] }) },
  } as unknown as QueryOptionsBuilderContext);
  const options = await builder.build({
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    askUserQuestionHook: async () => ({}),
  });
  options.env = { ...options.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  options.spawnClaudeCodeProcess = input => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, signal: input.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    return child;
  };
  return options;
}

try {
  for (const prepared of [false, true]) {
    const options = await built(prepared);
    const sandboxEnabled = options.sandbox?.enabled === true;
    const removeFlags = writeFlags(options, prepared ? 'prepared' : 'ordinary');
    if (prepared) {
      assert.equal(sandboxEnabled, true);
      const sandbox = typeof options.settings === 'string'
        ? JSON.parse(readFileSync(options.settings, 'utf8')).sandbox
        : options.sandbox;
      assert.equal(sandbox?.enabled, true);
    }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 20000);
    const q = query({ prompt: 'Report session initialization only.', options: { ...options, abortController } });
    let observedMode: string | undefined;
    let claudeCodeVersion: string | undefined;
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') {
          observedMode = message.permissionMode;
          claudeCodeVersion = message.claude_code_version;
          break;
        }
      }
    } finally { q.close(); clearTimeout(timer); removeFlags?.(); }
    assert(observedMode, 'native CLI did not emit system/init');
    (evidence.cases as unknown[]).push({ prepared, spawnMode: options.permissionMode ?? null, observedMode, claudeCodeVersion, sandboxEnabled });
    const expected = mode === 'baseline' ? 'auto' : prepared ? 'default' : 'bypassPermissions';
    assert.equal(observedMode, expected);
  }
  const policyOptions = await built(true);
  const removeFlags = writeFlags(policyOptions, 'policy');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const policyQuery = query({ prompt: (async function* () { await pending; })(), options: { ...policyOptions, abortController: controller } });
  try {
    await policyQuery.initializationResult();
    await assert.rejects(policyQuery.setPermissionMode('bypassPermissions'), /Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration/);
    evidence.policyRefusalReproduced = true;
  } finally { finish(); policyQuery.close(); clearTimeout(timer); removeFlags?.(); }
  assert.equal(readFileSync(userSettings, 'utf8'), originalSettings);
  evidence.userSettingsUnchanged = true;
  evidence.pass = true;
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  evidence.childrenStopped = true;
  rmSync(dirname(workerSandboxPaths(join(run, 'prepared')).TMPDIR), { recursive: true, force: true });
  evidence.workerRuntimeRemoved = true;
  writeFileSync(join(run, 'evidence/sdk-permission-spawn.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
