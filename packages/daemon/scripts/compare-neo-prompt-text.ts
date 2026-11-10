import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as prompts from '@hyperneo/prompts';
import { createDaemonApp } from '../src/app.ts';
import { getConfig } from '../src/config.ts';
import { neoPrompt } from '../src/lib/neo/prompt.ts';
import { withWorkerProvenance } from '../src/lib/drivers/worker-provenance.ts';
import { listOperationSummaries } from '../src/lib/operations/discovery.ts';
import { createOperationMcpServer } from '../src/lib/operations/mcp-server.ts';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)])
    );
  }
  return value;
}

const run = process.argv.at(-1)!;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/prompts.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const registry = app.sessionManager.getOperationRegistry();
const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo:synthetic' };
const server = createOperationMcpServer(registry, () => caller, undefined, 'neo');
const client = new Client({ name: 'neo-prompt-comparison', version: '1' });
try {
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  await client.connect(clientSide);
  const mcpTools = (await client.listTools()).tools
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const tools = listOperationSummaries(registry, caller, true).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if ('NEO_TOOL_DESCRIPTIONS' in prompts) {
    for (const [name, description] of Object.entries(prompts.NEO_TOOL_DESCRIPTIONS)) {
      assert.equal(prompts.neoToolDescription(name), description);
      assert.equal(registry.get(name)?.description, description);
    }
  }
  const result = sorted({
    mcpTools,
    tools,
    systemPrompt: neoPrompt(
      [
        {
          id: 'synthetic',
          describe: 'Synthetic domain',
          skill: 'synthetic-skill',
          guidance: 'Synthetic guidance.',
        },
      ],
      ['Synthetic rule.'],
      [
        {
          pack: 'synthetic',
          scope: { kind: 'global', key: '' },
          key: 'setting',
          value: 'value',
          setBy: 'human',
          setAt: 1,
        },
      ]
    ),
    workerProvenance: withWorkerProvenance('Synthetic instruction.', {
      model: 'synthetic-model-variant',
      effort: 'synthetic-effort',
      harness: 'codex',
    }).replace(/^Worker delivery: [^\n]+/, 'Worker delivery: 10000000-0000-4000-8000-000000000001'),
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence/comparison.json'), json);
  console.log(json.trimEnd());
} finally {
  await client.close();
  await server.instance.close();
  await app.cleanup();
}
