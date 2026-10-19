const [, , name, json = '{}', wait = '0'] = process.argv;
const port = process.env.VERIFY_PORT;
if (!port || !name) {
  console.error('usage: VERIFY_PORT=<port> bun rpc.ts <operation | rpc:method> [json] [eventSeconds]');
  process.exit(2);
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const id = crypto.randomUUID();
const events: unknown[] = [];
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 120_000);
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'EVENT') events.push({ method: message.method, data: message.data });
    if (message.requestId === id || message.id === id) {
      clearTimeout(timer);
      resolve(message.error ? { error: message.error } : message.data);
    }
  };
  const call = name.startsWith('rpc:')
    ? { method: name.slice(4), data: JSON.parse(json) }
    : { method: 'operation.invoke', data: { name, input: JSON.parse(json) } };
  ws.send(
    JSON.stringify({
      id,
      type: 'REQ',
      sessionId: 'global',
      ...call,
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    })
  );
});
await new Promise((resolve) => setTimeout(resolve, Number(wait) * 1000));
console.log(JSON.stringify({ reply, ...(events.length ? { events } : {}) }, null, 1));
ws.close();
