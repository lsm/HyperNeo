import assert from 'node:assert/strict';
import { CustomEndpointProvider } from '../../../packages/daemon/src/lib/providers/custom-endpoint-provider.ts';

const models = [
  { id: 'reasoning-model-a' },
  { id: 'reasoning-model-b', format: { type: 'json_schema', schema: { type: 'object' } } },
];

for (const llamaCppThinkingOff of [false, true]) {
  const received: Record<string, unknown>[] = [];
  const provider = new CustomEndpointProvider(
    {
      id: 'thinking-off-proof',
      name: 'Thinking Off proof',
      type: 'anthropic-messages',
      baseUrl: 'http://127.0.0.1:1',
      llamaCppThinkingOff,
      models: models.map(({ id }) => ({ id })),
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
    for (const [index, { id: model, format }] of models.entries()) {
      await provider.ensureBridgeStarted(model, session);
      const { envVars } = provider.buildSdkConfig(model, session);
      const formatOptions = format ? { format } : undefined;
      const outputConfig = { effort: 'high', ...formatOptions };
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
            output_config: outputConfig,
            reasoning_effort: 'high',
            ...(llamaCppThinkingOff ? { chat_template_kwargs: { custom_option: 'preserve' } } : {}),
          }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).content[0].text, 'Session summary');
      }
      const [off, high, auto] = received.slice(index * 3, (index + 1) * 3);
      assert.deepEqual(off.thinking, { type: 'disabled' });
      assert.deepEqual(
        off.chat_template_kwargs,
        llamaCppThinkingOff ? { custom_option: 'preserve', enable_thinking: false } : undefined
      );
      assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 24000 });
      assert.equal(auto.thinking, undefined);
      assert.deepEqual(off.output_config, llamaCppThinkingOff ? formatOptions : outputConfig);
      assert.equal(off.reasoning_effort, llamaCppThinkingOff ? undefined : 'high');
      for (const request of [high, auto]) {
        assert.deepEqual(request.output_config, outputConfig);
        assert.equal(request.reasoning_effort, 'high');
        assert.deepEqual(
          request.chat_template_kwargs,
          llamaCppThinkingOff ? { custom_option: 'preserve' } : undefined
        );
      }
    }
    assert.equal(received.length, 6);
    console.log(`PASS: six bridge requests with llama.cpp compatibility ${llamaCppThinkingOff}`);
  } finally {
    await provider.shutdown();
  }
}
