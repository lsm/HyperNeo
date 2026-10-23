import type { AgentMemoryEmbedder } from './agent-memory-repository.ts';
import { DIMENSIONS, MODEL_ID } from './agent-memory-transformers.ts';
import { Logger } from '../../lib/logger.ts';

const log = new Logger('EmbeddingWorker');

const EMBED_TIMEOUT_MS = 120_000;

type EmbedResponse =
  | { ready: true }
  | { loadError: string; retryable?: boolean }
  | { vector: ArrayBuffer }
  | { error: string };
type Running = {
  worker: Worker;
  ready: Promise<void>;
  answer: ((response: EmbedResponse) => void) | null;
  crash: ((error: Error) => void) | null;
};

function createEmbedWorker(): Worker {
  return new Worker(new URL('./agent-memory-embed-worker.ts', import.meta.url).href, {
    type: 'module',
  });
}

export class WorkerAgentMemoryEmbedder implements AgentMemoryEmbedder {
  model = MODEL_ID;
  dimensions = DIMENSIONS;
  private running: Running | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private retryAt = 0;
  private failures = 0;
  private unavailable: Error | null = null;
  private loggedFailure: string | null = null;

  constructor(
    private readonly createWorker: () => Worker = createEmbedWorker,
    private readonly timeoutMs = EMBED_TIMEOUT_MS
  ) {}

  embedQuery(text: string): Promise<Float32Array> {
    return this.enqueue('query', text);
  }

  embedPassage(text: string): Promise<Float32Array> {
    return this.enqueue('passage', text);
  }

  warm(): void {
    if (Date.now() < this.retryAt) return;
    this.running ??= this.spawn();
  }

  stop(): void {
    this.running?.worker.terminate();
    this.running = null;
  }

  private enqueue(kind: 'query' | 'passage', text: string): Promise<Float32Array> {
    const next = this.queue.then(() => this.request(kind, text));
    this.queue = next.catch(() => {});
    return next;
  }

  private async request(kind: 'query' | 'passage', text: string): Promise<Float32Array> {
    if (this.unavailable && Date.now() < this.retryAt) throw this.unavailable;
    const running = (this.running ??= this.spawn());
    await running.ready;
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        running.answer = null;
        running.crash = null;
      };
      const fail = (error: Error) => {
        settle();
        if (this.running === running) this.stop();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`embedding worker gave no answer in ${this.timeoutMs} ms`)),
        this.timeoutMs
      );
      running.crash = fail;
      running.answer = (response) => {
        settle();
        if ('vector' in response) resolve(new Float32Array(response.vector));
        else reject(new Error('error' in response ? response.error : 'unexpected worker answer'));
      };
      running.worker.postMessage({ kind, text });
    });
  }

  private spawn(): Running {
    const worker = this.createWorker();
    (worker as Worker & { unref?: () => void }).unref?.();
    let loaded: (() => void) | null = null;
    let failed: ((error: Error) => void) | null = null;
    const running: Running = {
      worker,
      ready: new Promise<void>((resolve, reject) => {
        loaded = resolve;
        failed = reject;
      }),
      answer: null,
      crash: null,
    };
    running.ready.catch(() => {});
    let ready = false;
    const lose = (error: Error, retryable = true) => {
      if (!ready) {
        this.unavailable = error;
        this.retryAt = retryable
          ? Date.now() + Math.min(300_000, 30_000 * 2 ** this.failures++)
          : Infinity;
        if (this.loggedFailure !== error.message) {
          this.loggedFailure = error.message;
          log.warn('Embeddings unavailable; initialization retry backed off:', error.message);
        }
      }
      if (this.running === running) this.stop();
      failed?.(error);
      running.crash?.(error);
    };
    worker.onmessage = ({ data }: MessageEvent<EmbedResponse>) => {
      if ('ready' in data) {
        ready = true;
        this.unavailable = null;
        this.retryAt = 0;
        this.failures = 0;
        this.loggedFailure = null;
        loaded?.();
      } else if ('loadError' in data)
        lose(new Error(`embedding model failed to load: ${data.loadError}`), data.retryable);
      else running.answer?.(data);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      lose(new Error(`embedding worker crashed: ${event.message}`));
    };
    return running;
  }
}
