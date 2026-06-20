import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  prefetchAgentMemoryEmbeddingModel,
  resetAgentMemoryEmbedderStateForTests,
} from '../../../src/storage/repositories/agent-memory-transformers.ts';
import { withoutAuthorization } from '../../../src/storage/repositories/agent-memory-fetch-options.ts';

const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_q4.onnx',
  'onnx/model_q4.onnx_data',
];

describe('agent memory transformers embedder', () => {
  test('removes authorization headers from redirected fetch options', () => {
    const options = {
      method: 'GET',
      headers: {
        authorization: 'Bearer hf-secret',
        'x-request-id': 'request-1',
      },
    };

    const sanitized = withoutAuthorization(options);

    expect(sanitized).not.toBe(options);
    expect(new Headers(sanitized?.headers).get('authorization')).toBeNull();
    expect(new Headers(sanitized?.headers).get('x-request-id')).toBe('request-1');
  });
});

describe('prefetchAgentMemoryEmbeddingModel', () => {
  beforeEach(() => {
    resetAgentMemoryEmbedderStateForTests();
  });

  function createCacheDir(): string {
    return mkdtempSync(join(tmpdir(), 'neokai-embed-cache-'));
  }

  function writeModelCache(cacheDir: string): void {
    for (const file of MODEL_FILES) {
      const filePath = join(cacheDir, 'huggingface.co', MODEL_ID, 'resolve/main', file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, 'cached');
    }
  }

  function cleanup(cacheDir: string): void {
    rmSync(cacheDir, { recursive: true, force: true });
  }

  function createFakeTransformers({ rejectLoad = false }: { rejectLoad?: boolean } = {}) {
    const env = { allowLocalModels: true, cacheDir: '/unused', fetch } as {
      allowLocalModels: boolean;
      cacheDir: string;
      fetch: typeof fetch;
    };

    const tokenizerFromPretrained = mock(() =>
      Promise.resolve({ call: mock(() => Promise.resolve({})) })
    );
    const modelFromPretrained = mock(() => Promise.resolve({}));

    const load = mock(() => {
      if (rejectLoad) return Promise.reject(new Error('transformers load failed'));
      return Promise.resolve({
        env,
        AutoTokenizer: {
          from_pretrained: tokenizerFromPretrained,
        },
        AutoModel: {
          from_pretrained: modelFromPretrained,
        },
      });
    });

    return { load, tokenizerFromPretrained, modelFromPretrained, env };
  }

  test('cache hit is a no-op and does not load transformers', async () => {
    const cacheDir = createCacheDir();
    writeModelCache(cacheDir);
    const logs: string[] = [];
    const fake = createFakeTransformers();

    try {
      await prefetchAgentMemoryEmbeddingModel({
        cacheDir,
        loadTransformers: fake.load,
        logInfo: (msg, ...rest) => logs.push(`INFO ${msg} ${rest.map(String).join(' ')}`),
        logError: (msg, ...rest) => logs.push(`ERR ${msg} ${rest.map(String).join(' ')}`),
      });

      expect(fake.load).not.toHaveBeenCalled();
      expect(fake.tokenizerFromPretrained).not.toHaveBeenCalled();
      expect(fake.modelFromPretrained).not.toHaveBeenCalled();
      expect(logs.some((msg) => msg.includes('already cached'))).toBe(true);
    } finally {
      cleanup(cacheDir);
    }
  });

  test('cache miss starts a background download with the correct model and options', async () => {
    const cacheDir = createCacheDir();
    const logs: string[] = [];
    const fake = createFakeTransformers();

    try {
      const result = await prefetchAgentMemoryEmbeddingModel({
        cacheDir,
        loadTransformers: fake.load,
        logInfo: (msg, ...rest) => logs.push(`INFO ${msg} ${rest.map(String).join(' ')}`),
        logError: (msg, ...rest) => logs.push(`ERR ${msg} ${rest.map(String).join(' ')}`),
      });

      expect(fake.load).toHaveBeenCalled();
      expect(fake.tokenizerFromPretrained).toHaveBeenCalled();
      expect(fake.tokenizerFromPretrained.mock.calls[0]?.[0]).toBe(MODEL_ID);
      expect(fake.modelFromPretrained).toHaveBeenCalled();
      const modelCall = fake.modelFromPretrained.mock.calls[0];
      expect(modelCall?.[0]).toBe(MODEL_ID);
      expect(modelCall?.[1]).toMatchObject({ dtype: 'q4' });
      expect(result).not.toBeNull();
      expect(logs.some((msg) => msg.includes('starting background prefetch'))).toBe(true);
      expect(logs.some((msg) => msg.includes('prefetch completed'))).toBe(true);
    } finally {
      cleanup(cacheDir);
    }
  });

  test('prefetch failure is logged and does not throw', async () => {
    const cacheDir = createCacheDir();
    const errors: string[] = [];
    const fake = createFakeTransformers({ rejectLoad: true });

    try {
      const result = await prefetchAgentMemoryEmbeddingModel({
        cacheDir,
        loadTransformers: fake.load,
        logInfo: () => {},
        logError: (msg, ...rest) => errors.push(`${msg} ${rest.map(String).join(' ')}`),
      });

      expect(result).toBeNull();
      expect(errors.some((msg) => msg.includes('prefetch failed'))).toBe(true);
    } finally {
      cleanup(cacheDir);
    }
  });

  test('configures transformers to skip local model path lookup', async () => {
    const cacheDir = createCacheDir();
    const fake = createFakeTransformers();

    try {
      await prefetchAgentMemoryEmbeddingModel({
        cacheDir,
        loadTransformers: fake.load,
        logInfo: () => {},
        logError: () => {},
      });

      expect(fake.load).toHaveBeenCalled();
      expect(fake.env.allowLocalModels).toBe(false);
    } finally {
      cleanup(cacheDir);
    }
  });
});
