type WorkerGlobal = {
  onmessage: ((event: { data: { kind: string; text: string } }) => void | Promise<void>) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

const worker = globalThis as unknown as WorkerGlobal;
const load = process.env.FAKE_EMBED_LOAD ?? '';
let inFlight = 0;

if (load === 'missing-native')
  worker.postMessage({
    loadError: "Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'",
  });
else if (load === 'fail') worker.postMessage({ loadError: 'model files missing' });
else setTimeout(() => worker.postMessage({ ready: true }), load === 'slow' ? 400 : 0);

worker.onmessage = async ({ data }) => {
  if (data.text === 'hang') return;
  if (data.text === 'crash') throw new Error('fake embedder crashed');
  if (data.text === 'refuse') return worker.postMessage({ error: 'model unavailable' });
  inFlight += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const vector = Float32Array.from([data.text.length, 0.1, -0.3333333, inFlight]);
  inFlight -= 1;
  worker.postMessage({ vector: vector.buffer }, [vector.buffer]);
};
