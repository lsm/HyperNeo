import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [listen, target, dir] = process.argv.slice(2);
if (!listen || !target || !dir || [listen, target].includes('8399'))
  throw new Error('usage: tls-front.ts <listen-port> <daemon-port> <dir> (never 8399)');
mkdirSync(dir, { recursive: true });
const cert = join(dir, 'front.crt');
const key = join(dir, 'front.key');
const config = join(dir, 'front.cnf');
writeFileSync(config, '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\n');
const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config]);
if (made.exitCode !== 0) throw new Error(made.stderr.toString());
const upstream = `127.0.0.1:${target}`;
type Link = { daemon: WebSocket; queued: (string | Uint8Array)[] };
Bun.serve<Link>({
  port: Number(listen),
  hostname: '127.0.0.1',
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(req, server) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const daemon = new WebSocket(`ws://${upstream}${url.pathname}${url.search}`, {
        headers: { cookie: headers.get('cookie') ?? '', origin: headers.get('origin') ?? '' },
      } as unknown as string[]);
      return server.upgrade(req, { data: { daemon, queued: [] } }) ? undefined : new Response('no upgrade', { status: 400 });
    }
    return fetch(`http://${upstream}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
  },
  websocket: {
    open(ws) {
      const { daemon, queued } = ws.data;
      daemon.binaryType = 'arraybuffer';
      daemon.onmessage = (event) => ws.send(event.data as string);
      daemon.onclose = () => ws.close();
      daemon.onopen = () => queued.splice(0).forEach((message) => daemon.send(message));
    },
    message(ws, message) {
      const { daemon, queued } = ws.data;
      if (daemon.readyState === WebSocket.OPEN) daemon.send(message);
      else queued.push(message);
    },
    close(ws) {
      ws.data.daemon.close();
    },
  },
});
console.log(`tls front on https://127.0.0.1:${listen}`);
