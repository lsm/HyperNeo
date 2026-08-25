import { describe, expect, it } from 'bun:test';
import { createNodeServer } from '../../../src/lib/runtime-server/node-backend';
import type { ServerHandle } from '../../../src/lib/runtime-server/types';

async function withNodeServer(
  fetch: Parameters<typeof createNodeServer>[0]['fetch'],
  websocket?: Parameters<typeof createNodeServer>[0]['websocket']
): Promise<ServerHandle> {
  return createNodeServer({ hostname: '127.0.0.1', port: 0, fetch, websocket });
}

describe('runtime-server node backend', () => {
  it('streams response bodies incrementally instead of buffering until completion', async () => {
    let streamEndStarted = 0;
    const server = await withNodeServer(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          setTimeout(() => {
            streamEndStarted = Date.now();
            controller.enqueue(encoder.encode('data: second\n\n'));
            controller.close();
          }, 400);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    });

    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    const firstChunkAt = Date.now();

    expect(first).toBe('data: first\n\n');
    expect(firstChunkAt - startedAt).toBeLessThan(400);

    const second = decoder.decode((await reader.read()).value);
    expect(second).toBe('data: second\n\n');
    expect(streamEndStarted).toBeGreaterThan(0);

    server.stop(true);
  });

  it('pipes request bodies into the fetch handler Request', async () => {
    const server = await withNodeServer(async (req) => {
      const body = (await req.json()) as { model: string; messages: string[] };
      return Response.json({ echoed: body });
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5', messages: ['hi'] }),
    });
    const json = (await res.json()) as { echoed: { model: string; messages: string[] } };
    expect(json.echoed).toEqual({ model: 'glm-5', messages: ['hi'] });

    server.stop(true);
  });

  it('carries request headers and method into the fetch handler Request', async () => {
    const seen: Array<{ method: string; auth: string | null }> = [];
    const server = await withNodeServer(async (req) => {
      seen.push({ method: req.method, auth: req.headers.get('authorization') });
      return new Response('ok');
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
      method: 'GET',
      headers: { Authorization: 'Bearer custom-endpoint:sess-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(seen).toEqual([{ method: 'GET', auth: 'Bearer custom-endpoint:sess-1' }]);

    server.stop(true);
  });

  it('cancels the upstream body reader when the client disconnects mid-stream', async () => {
    let upstreamCancelled = false;
    let secondChunkProduced = false;
    const server = await withNodeServer(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          setTimeout(() => {
            secondChunkProduced = true;
            controller.enqueue(encoder.encode('data: second\n\n'));
          }, 800);
        },
        cancel() {
          upstreamCancelled = true;
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe('data: first\n\n');

    controller.abort();
    const deadline = Date.now() + 5000;
    while (!upstreamCancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(upstreamCancelled).toBe(true);
    expect(secondChunkProduced).toBe(false);

    server.stop(true);
  });

  it('aborts the request signal when the client disconnects before the response starts', async () => {
    let clientSignal: AbortSignal | undefined;
    const server = await withNodeServer(async (req) => {
      clientSignal = req.signal;
      await new Promise<Response>(() => {});
      return new Response('never');
    });

    const controller = new AbortController();
    const resPromise = fetch(`http://127.0.0.1:${server.port}/health`, {
      signal: controller.signal,
    });

    const started = Date.now() + 5000;
    while (!clientSignal && Date.now() < started) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(clientSignal).toBeDefined();

    controller.abort();
    await resPromise.catch(() => {});

    const deadline = Date.now() + 5000;
    while (!clientSignal?.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(clientSignal?.aborted).toBe(true);

    server.stop(true);
  });

  it('upgrades websocket connections and echoes messages', async () => {
    const opened: string[] = [];
    const server = await withNodeServer(
      async (req, upgrade) => {
        if (new URL(req.url).pathname === '/ws') {
          const upgradeResponse = upgrade(req, { connectionSessionId: 'global' });
          if (upgradeResponse) return upgradeResponse;
        }
        return new Response('Not found', { status: 404 });
      },
      {
        open(ws) {
          opened.push(String((ws.data as { connectionSessionId: string }).connectionSessionId));
        },
        message(ws, message) {
          ws.send(`echo:${typeof message === 'string' ? message : ''}`);
        },
      }
    );

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const done = (error?: Error) => {
        ws.close();
        error ? reject(error) : resolve();
      };
      ws.onmessage = (event) => {
        if (event.data === 'echo:ping') done();
      };
      ws.onerror = () => done(new Error('websocket error'));
      ws.onopen = () => {
        ws.send('ping');
      };
    });

    expect(opened).toEqual(['global']);
    server.stop(true);
  });
});
