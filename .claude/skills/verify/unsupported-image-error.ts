import assert from 'node:assert/strict';
import { createAnthropicMessagesBridgeServer } from '../../../packages/daemon/src/lib/providers/anthropic-messages-bridge/server.ts';

const unsupportedImage =
  'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj';
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as { model: string };
    if (body.model === 'text-only') {
      return Response.json(
        { error: { type: 'server_error', code: 500, message: unsupportedImage } },
        { status: 500 }
      );
    }
    return Response.json(
      { error: { type: 'server_error', code: 500, message: 'Service unavailable' } },
      { status: 500 }
    );
  },
});
try {
  const bridge = await createAnthropicMessagesBridgeServer({ baseUrl: upstream.url.origin });
  try {
    const results = [];
    for (const model of ['text-only', 'overloaded-control']) {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
                },
              ],
            },
          ],
        }),
      });
      results.push({
        status: response.status,
        retry: response.headers.get('x-should-retry'),
        body: await response.json(),
      });
    }
    console.log(JSON.stringify(results));
    assert.deepEqual(results, [
      {
        status: 400,
        retry: 'false',
        body: { type: 'error', error: { type: 'invalid_request_error', message: unsupportedImage } },
      },
      {
        status: 529,
        retry: 'true',
        body: {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Service unavailable' },
        },
      },
    ]);
    console.log('PASS: two upstream HTTP errors retain their messages and differ in retry behavior');
  } finally {
    bridge.stop();
  }
} finally {
  upstream.stop(true);
}
