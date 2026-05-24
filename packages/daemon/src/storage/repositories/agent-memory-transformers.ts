import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withoutAuthorization } from './agent-memory-fetch-options';
import type { AgentMemoryEmbedder } from './agent-memory-repository';

const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GITHUB_RELEASE_BASE = 'https://github.com/lsm/neokai/releases/download/embedding-models-v1';
const DIMENSIONS = 384;

type TransformersModule = typeof import('@huggingface/transformers');
type InitializedEmbedder = {
  model: Awaited<ReturnType<TransformersModule['AutoModel']['from_pretrained']>>;
  tokenizer: Awaited<ReturnType<TransformersModule['AutoTokenizer']['from_pretrained']>>;
};

let modulePromise: Promise<TransformersModule> | null = null;
let fetchConfigured = false;

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
      this.initPromise = loadTransformersWeb()
        .then(async ({ AutoModel, AutoTokenizer }) => {
          const [model, tokenizer] = await Promise.all([
            AutoModel.from_pretrained(MODEL_ID, {
              dtype: 'q4',
              device: selectTransformersDevice(),
            }),
            AutoTokenizer.from_pretrained(MODEL_ID),
          ]);
          return { model, tokenizer };
        })
        .catch((err) => {
          this.initPromise = null;
          throw err;
        });
    }
    return this.initPromise;
  }
}

function loadTransformersWeb(): Promise<TransformersModule> {
  // The package's node export imports onnxruntime-node at module load time.
  // Load the web bundle explicitly so embeddings use WebGPU/WASM backends instead.
  if (!modulePromise) {
    modulePromise = import(pathToFileURL(transformersWebEntry()).href).then((module) => {
      const transformers = module as TransformersModule;
      configureFetch(transformers.env);
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

function configureFetch(env: TransformersModule['env']): void {
  if (fetchConfigured) return;
  fetchConfigured = true;
  const defaultFetch = env.fetch;
  env.fetch = (url, options) => {
    const urlString = url.toString();
    if (urlString.includes('huggingface.co') && urlString.includes('granite-embedding-small')) {
      const filename = urlString.split('/').pop();
      return defaultFetch(`${GITHUB_RELEASE_BASE}/${filename}`, withoutAuthorization(options));
    }
    return defaultFetch(url, options);
  };
}

function selectTransformersDevice(): 'webgpu' | 'wasm' {
  const maybeNavigator = globalThis.navigator as { gpu?: unknown } | undefined;
  return maybeNavigator?.gpu ? 'webgpu' : 'wasm';
}
