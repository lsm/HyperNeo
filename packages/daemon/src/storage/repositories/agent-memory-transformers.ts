import { getDataDir } from '../../lib/data-dir.ts';
import { Logger } from '../../lib/logger.ts';
import { access, constants, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { withoutAuthorization } from './agent-memory-fetch-options.ts';
import type { AgentMemoryEmbedder } from './agent-memory-repository.ts';
import {
  loadRecoveredEmbedding,
  MODEL_CHECKSUMS,
  verifyEmbeddingAsset,
} from './embedding-assets.ts';

const log = new Logger('AgentMemory');
export const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GITHUB_RELEASE_BASE = 'https://github.com/lsm/neokai/releases/download/embedding-models-v1';
export const DIMENSIONS = 384;
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_q4.onnx',
  'onnx/model_q4.onnx_data',
];

const REMOTE_HOST = 'https://huggingface.co/';
const REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';

const DEFAULT_TRANSFORMERS_CACHE_DIR = join(getDataDir(), 'cache', 'transformers');

type TransformersModule = typeof import('@huggingface/transformers');
type InitializedEmbedder =
  | { embed: (text: string) => Promise<Float32Array> }
  | {
      model: Awaited<ReturnType<TransformersModule['AutoModel']['from_pretrained']>>;
      tokenizer: Awaited<ReturnType<TransformersModule['AutoTokenizer']['from_pretrained']>>;
    };

let modulePromise: Promise<TransformersModule> | null = null;
let fetchConfigured = false;
let prefetchResult: Promise<InitializedEmbedder | null> | null = null;
let prefetchAbortController: AbortController | null = null;
let prefetchGeneration = 0;
let abortedPrefetchGenerations = new Set<number>();

export class TransformersAgentMemoryEmbedder implements AgentMemoryEmbedder {
  model = MODEL_ID;
  dimensions = DIMENSIONS;
  private initPromise: Promise<InitializedEmbedder> | null = null;

  embedQuery(text: string): Promise<Float32Array> {
    return this.getInit().then(async (initialized) => {
      if ('embed' in initialized) return initialized.embed(text);
      const { model, tokenizer } = initialized;
      const inputs = await tokenizer(text, { padding: true, truncation: true });
      const { sentence_embedding: sentenceEmbedding } = await model(inputs);
      return Float32Array.from(sentenceEmbedding.normalize().data);
    });
  }

  embedPassage(text: string): Promise<Float32Array> {
    return this.embedQuery(text);
  }

  load(): Promise<void> {
    return this.getInit().then(() => {});
  }

  private getInit(): Promise<InitializedEmbedder> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const generation = prefetchGeneration;
        const prefetched = prefetchResult ? await prefetchResult : null;
        if (prefetched) return prefetched;
        if (abortedPrefetchGenerations.has(generation)) {
          throw new Error('Agent memory embedding model load aborted');
        }

        const transformers = await loadTransformers().catch((error) => {
          if (error instanceof Error && /onnxruntime/i.test(error.message)) return null;
          throw error;
        });
        if (!transformers)
          return { embed: await loadRecoveredEmbedding(DEFAULT_TRANSFORMERS_CACHE_DIR, MODEL_ID) };
        const { AutoModel, AutoTokenizer } = transformers;
        const [model, tokenizer] = await Promise.all([
          AutoModel.from_pretrained(MODEL_ID, { dtype: 'q4', device: 'cpu' }),
          AutoTokenizer.from_pretrained(MODEL_ID),
        ]);
        return { model, tokenizer };
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }
}

export interface PrefetchOptions {
  cacheDir?: string;
  loadTransformers?: () => Promise<TransformersModule>;
  logInfo?: (message: string, ...args: unknown[]) => void;
  logError?: (message: string, ...args: unknown[]) => void;
}

export async function prefetchAgentMemoryEmbeddingModel(
  options: PrefetchOptions = {}
): Promise<InitializedEmbedder | null> {
  if (prefetchResult) return prefetchResult;

  const {
    cacheDir,
    loadTransformers: load = loadTransformers,
    logInfo = () => {},
    logError = () => {},
  } = options;

  const generation = prefetchGeneration + 1;
  prefetchGeneration = generation;
  abortedPrefetchGenerations.delete(generation);
  const abortController = new AbortController();

  prefetchAbortController = abortController;
  prefetchResult = (async (): Promise<InitializedEmbedder | null> => {
    try {
      if (cacheDir && (await isModelCached(cacheDir))) {
        logInfo('[AgentMemory] Embedding model already cached, prefetch skipped');
        return null;
      }

      const transformers = await load();
      const resolvedCacheDir =
        cacheDir ?? transformers.env.cacheDir ?? DEFAULT_TRANSFORMERS_CACHE_DIR;
      configureTransformersEnv(transformers.env, resolvedCacheDir);

      if (await isModelCached(resolvedCacheDir)) {
        logInfo('[AgentMemory] Embedding model already cached, prefetch skipped');
        return null;
      }

      if (abortedPrefetchGenerations.has(generation)) {
        logInfo('[AgentMemory] Embedding model prefetch aborted during shutdown');
        return null;
      }

      logInfo('[AgentMemory] Embedding model not cached, starting background prefetch');
      try {
        const [model, tokenizer] = await Promise.all([
          transformers.AutoModel.from_pretrained(MODEL_ID, { dtype: 'q4', device: 'cpu' }),
          transformers.AutoTokenizer.from_pretrained(MODEL_ID),
        ]);
        logInfo('[AgentMemory] Embedding model prefetch completed');
        return { model, tokenizer };
      } catch (err) {
        if (await isModelCached(resolvedCacheDir)) {
          logInfo('[AgentMemory] Embedding model prefetch completed (assets cached)');
          return null;
        }
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
        throw err;
      }
    } catch (err) {
      if (abortController.signal.aborted && abortedPrefetchGenerations.has(generation)) {
        logInfo('[AgentMemory] Embedding model prefetch aborted during shutdown');
        return null;
      }
      logError('[AgentMemory] Embedding model prefetch failed (non-fatal):', err);
      return null;
    } finally {
      if (prefetchAbortController === abortController) {
        prefetchAbortController = null;
      }
    }
  })();

  return prefetchResult;
}

export function resetAgentMemoryEmbedderStateForTests(): void {
  modulePromise = null;
  fetchConfigured = false;
  prefetchResult = null;
  prefetchAbortController = null;
  prefetchGeneration = 0;
  abortedPrefetchGenerations = new Set<number>();
}

function loadTransformers(): Promise<TransformersModule> {
  modulePromise ??= import('@huggingface/transformers').then((transformers) => {
    configureTransformersEnv(transformers.env, DEFAULT_TRANSFORMERS_CACHE_DIR);
    return transformers;
  });
  return modulePromise;
}

function configureTransformersEnv(env: TransformersModule['env'], cacheDir: string): void {
  if (fetchConfigured) return;
  fetchConfigured = true;

  env.allowLocalModels = false;

  env.cacheDir = cacheDir;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = new TransformersFileCache(cacheDir);

  const defaultFetch = env.fetch;
  env.fetch = async (url, options) => {
    const urlString = url.toString();
    if (urlString.includes('huggingface.co') && urlString.includes('granite-embedding-small')) {
      const filename = urlString.split('/').pop();
      log.info('Fetching embedding model asset', filename);
      const response = await defaultFetch(`${GITHUB_RELEASE_BASE}/${filename}`, {
        ...withoutAuthorization(options),
        signal: prefetchAbortController?.signal,
      });
      if (response.ok) await new TransformersFileCache(cacheDir).put(urlString, response.clone());
      return response;
    }
    return defaultFetch(url, options);
  };
}

async function isModelCached(cacheDir: string): Promise<boolean> {
  const cache = new TransformersFileCache(cacheDir);
  try {
    for (const file of MODEL_FILES) {
      if (!(await cache.has(buildRemoteUrl(MODEL_ID, file)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function buildRemoteUrl(modelId: string, filename: string): string {
  const path = REMOTE_PATH_TEMPLATE.replaceAll('{model}', modelId).replaceAll('{revision}', 'main');
  return pathJoin(REMOTE_HOST, path, filename);
}

function pathJoin(...parts: string[]): string {
  const normalized = parts.map((part, index) => {
    let value = part;
    if (index) value = value.replace(/^\/+/, '');
    if (index !== parts.length - 1) value = value.replace(/\/+$/, '');
    return value;
  });
  return normalized.join('/');
}

class TransformersFileCache {
  constructor(private readonly cacheDir: string) {}

  private filePath(request: string): string {
    const url = new URL(request);
    return join(this.cacheDir, url.hostname, url.pathname);
  }

  async has(request: string): Promise<boolean> {
    try {
      await access(this.filePath(request), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async match(request: string): Promise<string | Response | undefined> {
    try {
      const filePath = this.filePath(request);
      await access(filePath, constants.F_OK);
      await this.verify(request, filePath);

      const filename = new URL(request).pathname.split('/').pop() ?? '';
      if (filename.endsWith('.json')) {
        const buffer = await readFile(filePath);
        const headers = new Headers();
        headers.set('content-length', String(buffer.length));
        headers.set('content-type', 'application/json');
        return new Response(buffer, { headers });
      }
      return filePath;
    } catch {
      return undefined;
    }
  }

  async put(
    request: string,
    response: Response,
    progressCallback?: (data: { progress: number; loaded: number; total: number }) => void
  ): Promise<void> {
    const filePath = this.filePath(request);
    await mkdir(dirname(filePath), { recursive: true });

    const id = process.pid;
    const randomSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpPath = `${filePath}.tmp.${id}.${randomSuffix}`;
    const stream = createWriteStream(tmpPath);

    try {
      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      let loaded = 0;

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const progressStream = new Readable({
        read() {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                this.push(null);
                return;
              }
              if (value) {
                loaded += value.length;
                if (total) {
                  progressCallback?.({ progress: (loaded / total) * 100, loaded, total });
                }
              }
              this.push(value);
            })
            .catch((err) => this.destroy(err));
        },
      });

      await pipeline(progressStream, stream);
      await this.verify(request, tmpPath);
      await rename(tmpPath, filePath);
      log.info(
        'Embedding model asset checksum verified',
        new URL(request).pathname.split('/').pop()
      );
    } catch (error) {
      if (!stream.destroyed) {
        stream.destroy();
        await new Promise<void>((resolve) => stream.once('close', resolve));
      }
      try {
        await unlink(tmpPath);
      } catch {}
      throw error;
    }
  }

  async delete(request: string): Promise<boolean> {
    try {
      await unlink(this.filePath(request));
      return true;
    } catch {
      return false;
    }
  }

  private async verify(request: string, file: string): Promise<void> {
    const name = new URL(request).pathname.split('/').pop() ?? '';
    const checksum = MODEL_CHECKSUMS[name];
    if (!checksum) throw new Error('Unverified embedding model asset: ' + name);
    await verifyEmbeddingAsset(file, checksum);
  }
}
