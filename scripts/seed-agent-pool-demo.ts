import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const RPC_TIMEOUT = 15_000;

const port = process.argv[2];
if (!port || !/^\d+$/.test(port)) {
  console.error('Usage: bun run scripts/seed-agent-pool-demo.ts <port>');
  process.exit(1);
}

function rpcCall(ws: WebSocket, method: string, data: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), RPC_TIMEOUT);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.requestId === id || msg.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener('message', handler);
        if (msg.type === 'RSP' && msg.error) {
          reject(new Error(`${method}: ${msg.error}`));
        } else {
          resolve(msg.data);
        }
      }
    };
    ws.addEventListener('message', handler);
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method,
        data,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WebSocket connection timed out')),
      RPC_TIMEOUT
    );
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${e}`));
    });
  });
}

const workspace = '/tmp/hyperneo-model-pool-demo-ws';
if (!existsSync(workspace)) {
  mkdirSync(workspace, { recursive: true });
  execSync('git init -q', { cwd: workspace });
}

const ws = await connectWebSocket(`ws://localhost:${port}/ws`);

const health = await rpcCall(ws, 'system.health');
if (health?.status !== 'ok') {
  throw new Error(`Daemon health check failed: ${JSON.stringify(health)}`);
}

const modelsResult = await rpcCall(ws, 'models.list', { useCache: true });
const models: Array<{ id: string; provider?: string }> = modelsResult?.models ?? [];
const distinctModels: Array<{ id: string; provider?: string }> = [];
const seenModelIds = new Set<string>();
const seenProviders = new Set<string>();
for (const model of models) {
  if (!model?.id) continue;
  if (model.provider && seenProviders.has(model.provider)) continue;
  if (seenModelIds.has(model.id)) continue;
  if (model.provider) seenProviders.add(model.provider);
  seenModelIds.add(model.id);
  distinctModels.push({ id: model.id, provider: model.provider });
  if (distinctModels.length >= 3) break;
}

let space: { id: string; name: string } | undefined;
try {
  space = await rpcCall(ws, 'space.create', {
    workspacePath: workspace,
    name: 'Model Pool Demo',
    description: 'Demo space for weighted model pools on worker agents',
  });
  console.log(`[seed] created space "${space.name}" (${space.id})`);
} catch (err) {
  console.log(
    `[seed] space.create failed (${err instanceof Error ? err.message : err}), reusing existing`
  );
  const spaces = await rpcCall(ws, 'space.list', {});
  space = (Array.isArray(spaces) ? spaces : (spaces?.spaces ?? [])).find(
    (s: { workspacePath?: string }) => s.workspacePath === workspace
  );
  if (!space) throw new Error('Could not create or find demo space');
  console.log(`[seed] reusing space "${space.name}" (${space.id})`);
}

const agentsResult = await rpcCall(ws, 'spaceAgent.list', { spaceId: space.id });
const agents: Array<{ id: string; name: string }> = agentsResult?.agents ?? [];
const byName = (name: string) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
const coder = byName('Coder');
const reviewer = byName('Reviewer');
if (!coder || !reviewer) {
  throw new Error(`Preset agents missing (have: ${agents.map((a) => a.name).join(', ')})`);
}

const model = (index: number): { model: string; provider?: string } | undefined => {
  const found = distinctModels[index];
  return found ? { model: found.id, provider: found.provider } : undefined;
};

const coderPool = [
  { ...(model(0) ?? { model: 'sonnet' }), maxConcurrent: 8, weight: 50 },
  { ...(model(1) ?? { model: 'glm-5' }), maxConcurrent: 4, weight: 52 },
  { ...(model(2) ?? { model: 'kimi-k3[1m]' }), maxConcurrent: 2, weight: 80 },
].filter((entry) => !!entry.model);

const reviewerPool = [
  { ...(model(0) ?? { model: 'sonnet' }), maxConcurrent: 3, weight: 60 },
  { ...(model(1) ?? { model: 'glm-5' }), maxConcurrent: 2, weight: 40 },
].filter((entry) => !!entry.model);

await rpcCall(ws, 'spaceAgent.update', {
  id: coder.id,
  spaceId: space.id,
  modelPool: coderPool,
});
console.log(
  `[seed] set Coder model pool: ${coderPool.map((e) => `${e.model}(max ${e.maxConcurrent} w${e.weight})`).join(', ')}`
);

await rpcCall(ws, 'spaceAgent.update', {
  id: reviewer.id,
  spaceId: space.id,
  modelPool: reviewerPool,
});
console.log(
  `[seed] set Reviewer model pool: ${reviewerPool.map((e) => `${e.model}(max ${e.maxConcurrent} w${e.weight})`).join(', ')}`
);

ws.close();

console.log('');
console.log('[seed] demo ready:');
console.log(`  URL:      http://localhost:${port}`);
console.log(`  Space:    ${space.name}`);
console.log('  Pools live on the worker agents (edit under Space -> Configure -> Agents):');
console.log(
  '    Coder    -> ' +
    coderPool.map((e) => `${e.model} max ${e.maxConcurrent} w${e.weight}`).join(' | ')
);
console.log(
  '    Reviewer -> ' +
    reviewerPool.map((e) => `${e.model} max ${e.maxConcurrent} w${e.weight}`).join(' | ')
);
console.log('  Every workflow slot using Coder/Reviewer (e.g. the built-in Coding workflow)');
console.log('  now picks its model per spawn by remaining capacity x weight; full pool queues.');
