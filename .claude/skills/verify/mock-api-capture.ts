import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const port = Number(process.env.VERIFY_MOCK_PORT ?? 8000);
const inner = await createMockApiServer({ port: port + 1 });
await inner.start();
Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && url.pathname.endsWith('/messages')) console.log(`CAPTURE ${body}`);
    return fetch(`${inner.serverUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body,
    });
  },
});
console.log(`capturing mock Anthropic API ready on http://127.0.0.1:${port}`);
await new Promise(() => {});
