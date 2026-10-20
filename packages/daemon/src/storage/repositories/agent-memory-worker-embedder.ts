import type { AgentMemoryEmbedder } from './agent-memory-repository.ts';
import { DIMENSIONS, MODEL_ID } from './agent-memory-transformers.ts';

const EMBED_TIMEOUT_MS = 120_000;

type EmbedResponse = { vector: ArrayBuffer } | { error: string };

export class WorkerAgentMemoryEmbedder implements AgentMemoryEmbedder {
  model = MODEL_ID;
  dimensions = DIMENSIONS;
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workerUrl = new URL('./agent-memory-embed-worker.ts', import.meta.url).href,
    private readonly timeoutMs = EMBED_TIMEOUT_MS
  ) {}

  embedQuery(text: string): Promise<Float32Array> {
    return this.enqueue('query', text);
  }

  embedPassage(text: string): Promise<Float32Array> {
    return this.enqueue('passage', text);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private enqueue(kind: 'query' | 'passage', text: string): Promise<Float32Array> {
    const next = this.queue.then(() => this.request(kind, text));
    this.queue = next.catch(() => {});
    return next;
  }

  private request(kind: 'query' | 'passage', text: string): Promise<Float32Array> {
    const worker = (this.worker ??= this.spawn());
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.stop();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`embedding worker gave no answer in ${this.timeoutMs} ms`)),
        this.timeoutMs
      );
      worker.onmessage = ({ data }: MessageEvent<EmbedResponse>) => {
        clearTimeout(timer);
        if ('vector' in data) resolve(new Float32Array(data.vector));
        else reject(new Error(data.error));
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(new Error(`embedding worker crashed: ${event.message}`));
      };
      worker.postMessage({ kind, text });
    });
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    (worker as Worker & { unref?: () => void }).unref?.();
    return worker;
  }
}
