import assert from 'node:assert/strict';
import { CustomEndpointProvider } from '../../../packages/daemon/src/lib/providers/custom-endpoint-provider.ts';

const models = ['reasoning-model-a', 'reasoning-model-b'];

for (const llamaCppThinkingOff of [false, true]) {
  const received: Record<string, unknown>[] = [];
  const provider = new CustomEndpointProvider(
    {
      id: 'thinking-off-proof',
      name: 'Thinking Off proof',
      type: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:1',
      llamaCppThinkingOff,
      models: models.map((id) => ({ id })),
    },
    {
      bridgeFetchImpl: async (_url, init) => {
        received.push(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)));
        return Response.json({ content: [{ type: 'text', text: 'Session summary' }] });
      },
    }
  );

  try {
    const session = { sessionId: 'thinking-off-proof' };
    for (const model of models) {
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
            ...(llamaCppThinkingOff ? { chat_template_kwargs: { custom_option: 'preserve' } } : {}),
          }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).content[0].text, 'Session summary');
      }
    }

    assert.equal(received.length, 6);
    for (let i = 0; i < received.length; i += 3) {
      const [off, high, auto] = received.slice(i, i + 3);
      assert.deepEqual(off.thinking, { type: 'disabled' });
      assert.deepEqual(
        off.chat_template_kwargs,
        llamaCppThinkingOff ? { custom_option: 'preserve', enable_thinking: false } : undefined
      );
      assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 24000 });
      assert.equal(auto.thinking, undefined);
      for (const request of [high, auto]) {
        assert.deepEqual(
          request.chat_template_kwargs,
          llamaCppThinkingOff ? { custom_option: 'preserve' } : undefined
        );
      }
    }
    console.log(`PASS: six bridge requests with llama.cpp compatibility ${llamaCppThinkingOff}`);
  } finally {
    await provider.shutdown();
  }
}
