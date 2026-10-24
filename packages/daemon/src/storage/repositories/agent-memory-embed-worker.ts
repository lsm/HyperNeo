import {
  prefetchAgentMemoryEmbeddingModel,
  TransformersAgentMemoryEmbedder,
} from './agent-memory-transformers.ts';

type EmbedRequest = { kind: 'query' | 'passage'; text: string };
type EmbedResponse =
  | { ready: true }
  | { loadError: string; retryable?: boolean }
  | { vector: ArrayBuffer }
  | { error: string };
type WorkerGlobal = {
  onmessage: ((event: { data: EmbedRequest }) => void | Promise<void>) | null;
  postMessage(message: EmbedResponse, transfer?: ArrayBuffer[]): void;
};

const worker = globalThis as unknown as WorkerGlobal;
const embedder = new TransformersAgentMemoryEmbedder();
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

prefetchAgentMemoryEmbeddingModel()
  .then(() => embedder.load())
  .then(
    () => worker.postMessage({ ready: true }),
    (err) =>
      worker.postMessage({
        loadError: message(err),
        retryable: !(err instanceof Error && 'retryable' in err && err.retryable === false),
      })
  );

worker.onmessage = async ({ data }) => {
  try {
    const vector = Float32Array.from(
      await (data.kind === 'query'
        ? embedder.embedQuery(data.text)
        : embedder.embedPassage(data.text))
    );
    worker.postMessage({ vector: vector.buffer }, [vector.buffer]);
  } catch (err) {
    worker.postMessage({ error: message(err) });
  }
};
