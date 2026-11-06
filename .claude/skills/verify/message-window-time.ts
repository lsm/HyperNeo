import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const [, , sessionId, limit = '50'] = process.argv;
const headers = { authorization: `Bearer ${await readLocalCredential()}` };
const ws = new WebSocket(`ws://127.0.0.1:${process.env.VERIFY_PORT}/ws`, { headers } as unknown as string[]);
await new Promise((done, fail) => {
  ws.onopen = done;
  ws.onerror = fail;
});
const send = (id: string, method: string, data: unknown) =>
  ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
const read = (start: (id: string) => void, done: (message: { method?: string; requestId?: string; id?: string; data?: { rows?: unknown[]; sdkMessages?: unknown[] } }, id: string) => boolean) =>
  new Promise<{ ms: number; bytes: number; rows: number }>((resolve, reject) => {
    const id = crypto.randomUUID();
    const began = performance.now();
    const timer = setTimeout(() => reject(new Error('window read timed out')), 60_000);
    ws.onmessage = (event) => {
      const text = String(event.data);
      const message = JSON.parse(text);
      if (!done(message, id)) return;
      clearTimeout(timer);
      resolve({ ms: Math.round(performance.now() - began), bytes: text.length, rows: (message.data.rows ?? message.data.sdkMessages).length });
    };
    start(id);
  });
const window: unknown[] = [];
const page: unknown[] = [];
for (let round = 0; round < 5; round++) {
  const subscriptionId = crypto.randomUUID();
  window.push(await read(
    (id) => send(id, 'liveQuery.subscribe', { queryName: 'messages.bySession', params: [sessionId, Number(limit)], subscriptionId }),
    (message) => message.method === 'liveQuery.snapshot'
  ));
  send(crypto.randomUUID(), 'liveQuery.unsubscribe', { subscriptionId });
  page.push(await read(
    (id) => send(id, 'message.sdkMessages', { sessionId, limit: Number(limit) }),
    (message, id) => message.requestId === id || message.id === id
  ));
}
console.log(JSON.stringify({ window, page }));
ws.close();
