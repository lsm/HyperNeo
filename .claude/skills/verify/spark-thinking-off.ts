import assert from 'node:assert/strict';
import { CustomEndpointProvider } from '../../../packages/daemon/src/lib/providers/custom-endpoint-provider.ts';

const model = 'Spark-X2.6-4B-Q4_K_M';
const received: Record<string, unknown>[] = [];
const provider = new CustomEndpointProvider(
  {
    id: 'spark-off-proof',
    name: 'Spark proof',
    type: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1:1',
    models: [{ id: model }],
  },
  {
    bridgeFetchImpl: async (_url, init) => {
      received.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)));
      return Response.json({ content: [{ type: 'text', text: 'Session summary' }] });
    },
  }
);

try {
  const session = { sessionId: 'spark-off-proof' };
  await provider.ensureBridgeStarted(model, session);
  const { envVars } = provider.buildSdkConfig(model, session);
  for (const level of ['off', 'think24k', 'auto']) {
    provider.setSessionThinkingConfig(session.sessionId, level);
    const response = await fetch(`${envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${envVars.ANTHROPIC_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 32000,
        messages: [{ role: 'user', content: 'Summarize the session so work can continue.' }],
        thinking: { type: 'adaptive' },
        chat_template_kwargs: { reasoning_effort: 'high' },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, 'Session summary');
  }

  assert.equal(received.length, 3);
  assert.deepEqual(received[0].chat_template_kwargs, {
    reasoning_effort: 'high',
    enable_thinking: false,
  });
  assert.deepEqual(received[1].thinking, { type: 'enabled', budget_tokens: 24000 });
  assert.deepEqual(received[2].chat_template_kwargs, { reasoning_effort: 'high' });
  assert.equal(received[2].thinking, undefined);
  console.log('PASS: three bridge requests, only Off disables Spark thinking');
} finally {
  await provider.shutdown();
}
