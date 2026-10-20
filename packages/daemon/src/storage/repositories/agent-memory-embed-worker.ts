import { TransformersAgentMemoryEmbedder } from './agent-memory-transformers.ts';

type EmbedRequest = { kind: 'query' | 'passage'; text: string };
type EmbedResponse = { vector: ArrayBuffer } | { error: string };
type WorkerGlobal = {
  onmessage: ((event: { data: EmbedRequest }) => void | Promise<void>) | null;
  postMessage(message: EmbedResponse, transfer?: ArrayBuffer[]): void;
};

const worker = globalThis as unknown as WorkerGlobal;
const embedder = new TransformersAgentMemoryEmbedder();

worker.onmessage = async ({ data }) => {
  try {
    const vector = Float32Array.from(
      await (data.kind === 'query'
        ? embedder.embedQuery(data.text)
        : embedder.embedPassage(data.text))
    );
    worker.postMessage({ vector: vector.buffer }, [vector.buffer]);
  } catch (err) {
    worker.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
