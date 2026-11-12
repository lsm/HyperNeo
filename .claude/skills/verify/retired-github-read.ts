process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), `#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(run, 'evidence/gh.jsonl'))},JSON.stringify(args)+'\\n');
if(!['pr','issue'].includes(args[0])||!['view','list'].includes(args[1])||!args.includes('--json'))process.exit(2);
const item={number:7,title:'Synthetic reference',state:'OPEN',url:'https://github.com/example/project/'+(args[0]==='pr'?'pull':'issues')+'/7'};
console.log(JSON.stringify(args[1]==='list'?[item]:item));
`, { mode: 0o700 });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const evidence: unknown[] = [];
let client: Client | undefined;
let server: ReturnType<typeof createOperationMcpServer> | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const registry = app.sessionManager.getOperationRegistry();
  server = createOperationMcpServer(registry, () => ({ role: 'neo', sessionId: 'synthetic' }), undefined, 'neo');
  client = new Client({ name: 'retirement-proof', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(right);
  await client.connect(left);
  const call = async (name: string, input: unknown) => {
    const reply = await client!.callTool({ name: 'invoke', arguments: { name, input } });
    assert(Array.isArray(reply.content));
    return JSON.parse((reply.content[0] as { text: string }).text);
  };
  const settings = new SettingsRepository(app.db.getDatabase());
  for (const packs of [[], ['coding']]) {
    settings.updateGlobalSettings({ neo: { ...settings.getGlobalSettings().neo, packs } });
    assert.equal(registry.get('neo.github.read'), undefined);
    assert(registry.get('neo.coding.assign'));
    assert.equal((await call('neo.github.read', {})).code, 'unknown_operation');
    assert.equal((await call('operations.describe', { name: 'neo.github.read' })).found, false);
    assert.deepEqual(await call('operations.list', { prefix: 'neo.github', all: true }), { total: 0, names: [], next: null });
    evidence.push({ packs, retired: true, codingAssignmentPresent: true });
  }
  for (const command of [
    'gh pr view https://github.com/example/project/pull/7 --json number,title,state',
    'gh issue view https://github.com/example/project/issues/7 --json number,title,state',
    "gh pr list --repo example/project --search 'updated:>=2026-10-15T10:00:00Z' --json number,title,state",
  ]) {
    const result = JSON.parse(execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' }));
    assert.equal((Array.isArray(result) ? result[0] : result).number, 7);
    evidence.push({ command, result });
  }
  const requests = readFileSync(join(run, 'evidence/gh.jsonl'), 'utf8').trim().split('\n');
  assert.equal(requests.length, 3);
  console.log(`PASS registry=${registry.entries.length} retiredOperations=1 ghReads=${requests.length} packStates=2`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await client?.close();
  await server?.instance.close();
  await app.cleanup();
}
