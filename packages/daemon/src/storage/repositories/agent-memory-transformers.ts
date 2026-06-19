import { createRequire } from 'node:module';
import { access, constants, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { withoutAuthorization } from './agent-memory-fetch-options';
import type { AgentMemoryEmbedder } from './agent-memory-repository';

const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GITHUB_RELEASE_BASE = 'https://github.com/lsm/neokai/releases/download/embedding-models-v1';
const DIMENSIONS = 384;
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_q4.onnx',
  'onnx/model_q4.onnx_data',
];

const REMOTE_HOST = 'https://huggingface.co/';
const REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';

const DEFAULT_TRANSFORMERS_CACHE_DIR = join(homedir(), '.neokai', 'cache', 'transformers');

type TransformersModule = typeof import('@huggingface/transformers');
type InitializedEmbedder = {
  model: Awaited<ReturnType<TransformersModule['AutoModel']['from_pretrained']>>;
  tokenizer: Awaited<ReturnType<TransformersModule['AutoTokenizer']['from_pretrained']>>;
};

let modulePromise: Promise<TransformersModule> | null = null;
let fetchConfigured = false;
let prefetchResult: Promise<InitializedEmbedder | null> | null = null;
let prefetchAbortController: AbortController | null = null;
let prefetchAborted = false;

export class TransformersAgentMemoryEmbedder implements AgentMemoryEmbedder {
  model = MODEL_ID;
  dimensions = DIMENSIONS;
  private initPromise: Promise<InitializedEmbedder> | null = null;

  embedQuery(text: string): Promise<Float32Array> {
    return this.getInit().then(async ({ model, tokenizer }) => {
      const inputs = await tokenizer(text, { padding: true, truncation: true });
      const { sentence_embedding: sentenceEmbedding } = await model(inputs);
      return Float32Array.from(sentenceEmbedding.normalize().data);
    });
  }

  embedPassage(text: string): Promise<Float32Array> {
    return this.embedQuery(text);
  }

  private getInit(): Promise<InitializedEmbedder> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const prefetched = prefetchResult ? await prefetchResult : null;
        if (prefetched) return prefetched;
        if (prefetchAborted) {
          throw new Error('Agent memory embedding model load aborted');
        }

        const { AutoModel, AutoTokenizer } = await loadTransformersWeb();
        const [model, tokenizer] = await Promise.all([
          AutoModel.from_pretrained(MODEL_ID, {
            dtype: 'q4',
            device: selectTransformersDevice(),
          }),
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

/**
 * Background-prefetch the agent-memory embedding model into the transformers
 * file cache. Resolves immediately when the model is already cached. Errors are
 * caught and logged; they never propagate to the caller so startup cannot be
 * blocked by a failed download.
 */
export async function prefetchAgentMemoryEmbeddingModel(
  options: PrefetchOptions = {}
): Promise<InitializedEmbedder | null> {
  if (prefetchResult) return prefetchResult;

  const {
    cacheDir,
    loadTransformers = loadTransformersWeb,
    logInfo = () => {},
    logError = () => {},
  } = options;

  prefetchResult = (async (): Promise<InitializedEmbedder | null> => {
    prefetchAbortController = new AbortController();
    try {
      // When a cache directory is supplied (tests), avoid loading the heavy
      // transformers bundle if the model is already cached.
      if (cacheDir && (await isModelCached(cacheDir))) {
        logInfo('[AgentMemory] Embedding model already cached, prefetch skipped');
        return null;
      }

      const transformers = await loadTransformers();
      const resolvedCacheDir =
        cacheDir ?? transformers.env.cacheDir ?? DEFAULT_TRANSFORMERS_CACHE_DIR;
      configureTransformersEnv(transformers.env, resolvedCacheDir);

      if (await isModelCached(resolvedCacheDir)) {
        logInfo('[AgentMemory] Embedding model already cached, prefetch skipped');
        return null;
      }

      logInfo('[AgentMemory] Embedding model not cached, starting background prefetch');
      try {
        const [model, tokenizer] = await Promise.all([
          transformers.AutoModel.from_pretrained(MODEL_ID, {
            dtype: 'q4',
            device: selectTransformersDevice(),
          }),
          transformers.AutoTokenizer.from_pretrained(MODEL_ID),
        ]);
        logInfo('[AgentMemory] Embedding model prefetch completed');
        return { model, tokenizer };
      } catch (err) {
        // The transformers web bundle may fail to instantiate the ONNX session
        // under Bun even though the model files were downloaded successfully.
        // Treat the prefetch as successful if all expected assets are now cached.
        if (await isModelCached(resolvedCacheDir)) {
          logInfo('[AgentMemory] Embedding model prefetch completed (assets cached)');
          return null;
        }
        throw err;
      }
    } catch (err) {
      if (prefetchAbortController?.signal.aborted) {
        prefetchAborted = true;
        logInfo('[AgentMemory] Embedding model prefetch aborted during shutdown');
        return null;
      }
      logError('[AgentMemory] Embedding model prefetch failed (non-fatal):', err);
      return null;
    } finally {
      prefetchAbortController = null;
    }
  })();

  return prefetchResult;
}

/**
 * Reset internal module state. Exported for unit tests only.
 */
export function resetAgentMemoryEmbedderStateForTests(): void {
  modulePromise = null;
  fetchConfigured = false;
  prefetchResult = null;
  prefetchAbortController = null;
  prefetchAborted = false;
}

/**
 * Abort an in-flight background prefetch. Called during graceful shutdown so a
 * large model download does not outlive the daemon process.
 */
export function abortAgentMemoryEmbeddingModelPrefetch(): void {
  prefetchAbortController?.abort();
}

function loadTransformersWeb(): Promise<TransformersModule> {
  // The package's node export imports onnxruntime-node at module load time.
  // Load the web bundle explicitly so embeddings use WebGPU/WASM backends instead.
  if (!modulePromise) {
    modulePromise = import(pathToFileURL(transformersWebEntry()).href).then((module) => {
      const transformers = module as TransformersModule;
      configureTransformersEnv(transformers.env, DEFAULT_TRANSFORMERS_CACHE_DIR);
      return transformers;
    });
  }
  return modulePromise;
}

function transformersWebEntry(): string {
  const require = createRequire(import.meta.url);
  const nodeEntry = require.resolve('@huggingface/transformers');
  return join(dirname(dirname(nodeEntry)), 'dist', 'transformers.web.js');
}

function configureTransformersEnv(env: TransformersModule['env'], cacheDir: string): void {
  if (fetchConfigured) return;
  fetchConfigured = true;

  // Avoid repeated "Unable to load from local path /models/..." warnings under
  // Bun/Node. The web bundle enables local model loading by default, but we only
  // use the remote GitHub release redirect plus the file cache.
  env.allowLocalModels = false;

  // The web bundle reports no filesystem support under Bun, so we provide a
  // custom file-backed cache. This keeps runtime loads fast and lets the
  // background prefetch actually persist downloaded assets.
  env.cacheDir = cacheDir;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = new TransformersFileCache(cacheDir);

  const defaultFetch = env.fetch;
  env.fetch = (url, options) => {
    const urlString = url.toString();
    if (urlString.includes('huggingface.co') && urlString.includes('granite-embedding-small')) {
      const filename = urlString.split('/').pop();
      return defaultFetch(`${GITHUB_RELEASE_BASE}/${filename}`, {
        ...withoutAuthorization(options),
        signal: prefetchAbortController?.signal,
      });
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

// The transformers.js web bundle picks the backend at runtime. Under Bun it
// resolves to onnxruntime-node, which only supports 'cpu' (and 'webgpu' on
// supported platforms). The legacy 'wasm' device is unsupported there, so we
// fall back to 'cpu' when WebGPU is unavailable.
function selectTransformersDevice(): 'webgpu' | 'cpu' {
  const maybeNavigator = globalThis.navigator as { gpu?: unknown } | undefined;
  return maybeNavigator?.gpu ? 'webgpu' : 'cpu';
}

/**
 * Minimal file-backed Cache API implementation for the transformers.js web
 * bundle. The web bundle does not detect Bun's filesystem APIs, so we plug in
 * our own cache to avoid re-downloading the embedding model on every process
 * start.
 *
 * Cache keys are full URLs. We map them to filesystem paths by stripping the
 * scheme so the layout is portable (no `:` characters, which are illegal in
 * Windows filenames) and deterministic.
 */
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

  async match(request: string): Promise<Response | undefined> {
    try {
      const buffer = await readFile(this.filePath(request));
      const headers = new Headers();
      headers.set('content-length', String(buffer.length));
      headers.set('content-type', 'application/octet-stream');
      return new Response(buffer, { headers });
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

    try {
      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      let loaded = 0;

      const stream = createWriteStream(tmpPath);
      const reader = response.body?.getReader();
      if (!reader) {
        stream.end();
        throw new Error('Response body is not readable');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise<void>((resolve, reject) => {
          stream.write(value, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        loaded += value.length;
        if (total) {
          progressCallback?.({ progress: (loaded / total) * 100, loaded, total });
        }
      }

      stream.end();
      await new Promise<void>((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      await rename(tmpPath, filePath);
    } catch (error) {
      try {
        await unlink(tmpPath);
      } catch {
        // ignore cleanup failure
      }
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
}
