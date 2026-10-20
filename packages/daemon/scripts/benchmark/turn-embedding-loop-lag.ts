import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.HYPERNEO_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'embed-lag-'));
process.env.HYPERNEO_DATA_DIR = dataDir;

const { TransformersAgentMemoryEmbedder } = await import(
  '../../src/storage/repositories/agent-memory-transformers.ts'
);
const { WorkerAgentMemoryEmbedder } = await import(
  '../../src/storage/repositories/agent-memory-worker-embedder.ts'
);

const words =
  'the build failed because the migration renamed a column that the task feed still reads so the worker reverted it and reran the shard'.split(
    ' '
  );
const text = (length: number) => {
  let out = '';
  for (let i = 0; out.length < length; i++) out += `${words[i % words.length]} `;
  return out.slice(0, length);
};

let maxLag = 0;
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  maxLag = Math.max(maxLag, now - last - 5);
  last = now;
}, 5);
const phase = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  maxLag = 0;
  last = performance.now();
  const started = performance.now();
  const value = await run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  console.log(
    `${name.padEnd(34)} wall ${(performance.now() - started).toFixed(0).padStart(6)} ms   max loop lag ${maxLag.toFixed(0).padStart(6)} ms`
  );
  return value;
};

const lengths = [80, 1_000, 4_000, 16_000, 64_000];
const embedders = {
  'main thread': new TransformersAgentMemoryEmbedder(),
  worker: new WorkerAgentMemoryEmbedder(),
};
const vectors: Record<string, Float32Array[]> = {};
for (const [name, embedder] of Object.entries(embedders)) {
  vectors[name] = [];
  await phase(`${name}: init + first embed`, () => embedder.embedPassage(text(80)));
  await phase(`${name}: job batch 32 x 2000 chars`, async () => {
    for (let turn = 0; turn < 32; turn++) await embedder.embedPassage(text(2_000 - turn));
  });
  for (const length of lengths)
    vectors[name].push(
      Float32Array.from(
        await phase(`${name}: embed ${length} chars`, () => embedder.embedPassage(text(length)))
      )
    );
}
embedders.worker.stop();
clearInterval(timer);
const identical = vectors['main thread'].every(
  (vector, index) =>
    vector.length === vectors.worker[index].length &&
    vector.every((value, at) => Object.is(value, vectors.worker[index][at]))
);
console.log(`vectors identical across main thread and worker: ${identical}`);
console.log(`data dir: ${dataDir}`);
if (!identical) process.exit(1);
