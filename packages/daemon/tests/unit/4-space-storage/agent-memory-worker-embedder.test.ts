import { describe, expect, test } from 'bun:test';
import { WorkerAgentMemoryEmbedder } from '../../../src/storage/repositories/agent-memory-worker-embedder.ts';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const fakeWorker =
  (load = '') =>
  () => {
    process.env.FAKE_EMBED_LOAD = load;
    return new Worker(new URL('../../helpers/fake-embed-worker.ts', import.meta.url).href, {
      type: 'module',
    });
  };

describe.skipIf(!isBun)('WorkerAgentMemoryEmbedder', () => {
  test('backs off a missing platform binding instead of reloading it for every input', async () => {
    let attempts = 0;
    const embedder = new WorkerAgentMemoryEmbedder(() => {
      attempts += 1;
      return fakeWorker('missing-native')();
    });
    try {
      for (const text of ['first', 'second', 'third']) {
        await expect(embedder.embedQuery(text)).rejects.toThrow(
          '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'
        );
      }
      expect(attempts).toBe(1);
    } finally {
      embedder.stop();
    }
  });

  test('returns the worker’s vector bit for bit, one request at a time', async () => {
    const embedder = new WorkerAgentMemoryEmbedder(fakeWorker());
    try {
      const vectors = await Promise.all(
        ['one', 'three', 'fiftyfive'].map((text) => embedder.embedPassage(text))
      );
      expect(vectors.map((vector) => Array.from(vector))).toEqual(
        ['one', 'three', 'fiftyfive'].map((text) =>
          Array.from(Float32Array.from([text.length, 0.1, -0.3333333, 1]))
        )
      );
    } finally {
      embedder.stop();
    }
  });

  test('a refused, crashed or hung request fails, and the next one gets a fresh worker', async () => {
    const embedder = new WorkerAgentMemoryEmbedder(fakeWorker(), 200);
    try {
      await expect(embedder.embedQuery('refuse')).rejects.toThrow('model unavailable');
      await expect(embedder.embedQuery('crash')).rejects.toThrow('embedding worker crashed');
      expect(Array.from(await embedder.embedQuery('ok'))[0]).toBe(2);
      await expect(embedder.embedQuery('hang')).rejects.toThrow('gave no answer in 200 ms');
      expect(Array.from(await embedder.embedQuery('again'))[0]).toBe(5);
    } finally {
      embedder.stop();
    }
  });

  test('a slow model load is not cut off by the request timeout', async () => {
    const embedder = new WorkerAgentMemoryEmbedder(fakeWorker('slow'), 100);
    try {
      expect(Array.from(await embedder.embedPassage('loaded'))[0]).toBe(6);
    } finally {
      embedder.stop();
    }
  });

  test('a model that fails to load is retried after its backoff and can recover', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    let spawned = 0;
    const embedder = new WorkerAgentMemoryEmbedder(() => {
      spawned += 1;
      return fakeWorker(spawned === 1 ? 'fail' : '')();
    });
    try {
      await expect(embedder.embedQuery('x')).rejects.toThrow(
        'embedding model failed to load: model files missing'
      );
      now += 30_000;
      expect(Array.from(await embedder.embedQuery('second'))[0]).toBe(6);
      expect(spawned).toBe(2);
    } finally {
      Date.now = originalNow;
      embedder.stop();
    }
  });
});
