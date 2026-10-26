const port = process.env.VERIFY_PORT;
if (!port) throw new Error('usage: VERIFY_PORT=<port> bun sdk-save-async.ts');
type Frame = { type?: string; id?: string; requestId?: string; method?: string; data?: any; error?: unknown };
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
const events: Frame[] = [];
const waiters = new Map<string, (frame: Frame) => void>();
ws.onmessage = (event) => {
  const frame = JSON.parse(String(event.data)) as Frame;
  if (frame.type === 'EVENT') events.push(frame);
  const id = frame.requestId ?? frame.id;
  if (id && waiters.has(id)) waiters.get(id)!(frame);
};
const rpc = (method: string, data: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = crypto.randomUUID();
    waiters.set(id, (frame) => (frame.error ? reject(new Error(JSON.stringify(frame.error))) : resolve(frame.data)));
    ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { sessionId } = await rpc('session.create', { workspacePath: '/tmp', title: 'Async save check' });
await rpc('liveQuery.subscribe', { queryName: 'messages.bySession', subscriptionId: 'chat', params: [sessionId, 50] });
await rpc('message.send', { sessionId, content: 'Reply with one short sentence.' });

const rowsOf = (frame: Frame): any[] => [...(frame.data?.rows ?? []), ...(frame.data?.added ?? []), ...(frame.data?.updated ?? [])];
const seen = () =>
  events
    .filter((frame) => frame.data?.subscriptionId === 'chat')
    .flatMap(rowsOf)
    .map((row) => (typeof row.sdk_message === 'string' ? JSON.parse(row.sdk_message) : row.sdkMessage ?? row))
    .map((message) => message?.type);
for (let n = 0; n < 600 && !(seen().includes('assistant') && seen().includes('result')); n++) await wait(100);

const types = seen();
const page = await rpc('message.sdkMessages', { sessionId, limit: 50 });
const stored = (page.sdkMessages ?? page.messages ?? []).map((message: any) => message.type);
console.log(JSON.stringify({ sessionId, liveTypes: [...new Set(types)], storedTypes: stored }, null, 2));
ws.close();
if (!types.includes('assistant') || !types.includes('result')) process.exit(1);
