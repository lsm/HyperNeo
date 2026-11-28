#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'memory-probe-'));
process.env.NODE_ENV = 'test';
process.env.HYPERNEO_DATA_DIR = process.env.MEMORY_PROBE_CACHE ?? dataDir;

const daemon = '../packages/daemon/src';
const { Database } = await import(`${daemon}/storage/sqlite-compat.ts`);
const { runMigrations } = await import(`${daemon}/storage/schema/index.ts`);
const { registerSchemaExtension } = await import(`${daemon}/storage/schema/extensions.ts`);
const { SPACE_SCHEMA } = await import(`${daemon}/storage/schema/space-schema.ts`);
const { AgentMemoryRepository } = await import(
  `${daemon}/storage/repositories/agent-memory-repository.ts`
);
const { MODEL_ID, TransformersAgentMemoryEmbedder } = await import(
  `${daemon}/storage/repositories/agent-memory-transformers.ts`
);
const { loadRecoveredEmbedding } = await import(
  `${daemon}/storage/repositories/embedding-assets.ts`
);

const memories: Record<string, string> = {
  m1: 'Run daemon tests with ./scripts/test-daemon.sh and pass a shard name.',
  m2: 'Releases are tags on the protected dev branch.',
  m3: 'Review pull requests before merging them, and merge with a squash commit.',
  m4: '每个工作区使用独立的数据库文件，数据库带有进程锁。',
  m5: '依赖版本必须固定为精确版本，不要使用范围符号。',
  m6: '界面组件使用 Preact 的写法，而不是 React 的接口。',
};
const crossQueries: Array<[string, string]> = [
  ['怎么运行守护进程的测试？', 'm1'],
  ['如何发布新版本', 'm2'],
  ['合并代码之前要做什么', 'm3'],
  ['database lock per worktree', 'm4'],
  ['pin exact dependency versions', 'm5'],
];
const unrelatedQueries = [
  'what is the weather in Paris tomorrow',
  'how do I bake sourdough bread',
  '推荐一部好看的电影',
  '明天去机场怎么走',
];

registerSchemaExtension(SPACE_SCHEMA);
const db = new Database(':memory:');
runMigrations(db, () => {});
const now = Date.now();
db.prepare(
  `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
   VALUES ('probe', '/tmp/probe', 'probe', '', '', '', '[]', '[]', 'probe', 'active', ?, ?)`
).run(now, now);

const embedder = new TransformersAgentMemoryEmbedder();
await embedder.load();
const repo = new AgentMemoryRepository(db, undefined, embedder);
for (const [key, content] of Object.entries(memories))
  repo.write({ spaceId: 'probe', key, content });
for (let tries = 0; tries < 600; tries++) {
  const pending = db
    .prepare(`SELECT count(*) AS n FROM space_agent_memory WHERE embedding_status != 'ready'`)
    .get() as { n: number };
  if (pending.n === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const passages = await Promise.all(
  Object.entries(memories).map(async ([key, content]) => ({
    key,
    vector: await embedder.embedPassage(`${key}\n${content}`),
  }))
);
const cosines = async (query: string) => {
  const vector = await embedder.embedQuery(query);
  return passages
    .map(({ key, vector: passage }) => ({
      key,
      cosine: passage.reduce(
        (sum: number, value: number, index: number) => sum + value * vector[index],
        0
      ),
    }))
    .sort((a, b) => b.cosine - a.cosine);
};

const failures: string[] = [];
const report = async (query: string, wanted: string | null) => {
  const keys = (await repo.search('probe', query, 3)).map(
    (hit: { memory: { key: string } }) => hit.memory.key
  );
  const scores = (await cosines(query))
    .slice(0, 3)
    .map(({ key, cosine }) => `${key}=${cosine.toFixed(3)}`)
    .join(' ');
  const ok = wanted ? keys[0] === wanted : keys.length === 0;
  if (!ok) failures.push(query);
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(query)} want=${wanted ?? 'none'} got=[${keys}] cos ${scores}`
  );
};

console.log(`model ${embedder.model}`);
console.log('ranks intended memories first both ways');
for (const [query, wanted] of crossQueries) await report(query, wanted);
console.log('returns no unrelated hits');
for (const query of unrelatedQueries) await report(query, null);
console.log('recovered runtime matches the transformers runtime');
const recovered = await loadRecoveredEmbedding(
  join(process.env.HYPERNEO_DATA_DIR, 'cache', 'transformers'),
  MODEL_ID
);
for (const text of ['数据库进程锁', 'run daemon tests']) {
  const [left, right] = await Promise.all([recovered(text), embedder.embedQuery(text)]);
  const cosine = left.reduce(
    (sum: number, value: number, index: number) => sum + value * right[index],
    0
  );
  const ok = cosine > 0.999;
  if (!ok) failures.push(`recovered ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(text)} cosine ${cosine.toFixed(6)}`);
}
console.log(`failures ${failures.length}`);
db.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
