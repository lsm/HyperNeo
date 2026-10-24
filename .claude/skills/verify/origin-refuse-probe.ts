const [port] = process.argv.slice(2);
const base = `127.0.0.1:${port}`;

const upgrade = (headers: Record<string, string>) =>
  new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers } as unknown as string[]);
    const timer = setTimeout(() => resolve('timeout'), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve('connected');
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve('refused');
    };
  });
const post = async (headers: Record<string, string>) =>
  String((await fetch(`http://${base}/pair`, { method: 'POST', headers, body: '{}' })).status);
const allow = (hosts: string[]) =>
  Bun.$`VERIFY_PORT=${port} bun ${import.meta.dir}/rpc.ts rpc:settings.global.update ${JSON.stringify({ updates: { allowedHosts: hosts } })}`.quiet();

const rows: [string, () => Promise<string>][] = [
  ['ws  foreign Origin https://evil.example', () => upgrade({ origin: 'https://evil.example' })],
  ['ws  opaque Origin null', () => upgrade({ origin: 'null' })],
  ['ws  same-origin (Host = Origin host)', () => upgrade({ host: 'mac.example.ts.net', origin: 'https://mac.example.ts.net' })],
  ['ws  loopback Origin http://localhost:5173', () => upgrade({ origin: 'http://localhost:5173' })],
  ['ws  no Origin', () => upgrade({})],
  ['ws  allowed host Origin (before allowing)', () => upgrade({ origin: 'https://web.example.ts.net' })],
  ['    allow web.example.ts.net', async () => ((await allow(['web.example.ts.net'])), 'set')],
  ['ws  allowed host Origin (after allowing)', () => upgrade({ origin: 'https://web.example.ts.net' })],
  ['POST /pair foreign Origin', () => post({ origin: 'https://evil.example' })],
  ['POST /pair same-origin', () => post({ host: 'mac.example.ts.net', origin: 'https://mac.example.ts.net' })],
  ['POST /pair no Origin', () => post({})],
  ['GET  / foreign Origin', async () => String((await fetch(`http://${base}/`, { headers: { origin: 'https://evil.example' } })).status)],
];
for (const [label, run] of rows) console.log(`${label.padEnd(44)} ${await run()}`);
await allow([]);
