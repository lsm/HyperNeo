import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  buildOneShotQueryOptions,
  firstAssistantText,
  oneShotModelIds,
  runOneShotModel,
  type OneShotModelRequest,
} from '../../../../src/lib/agent/one-shot-model';

const request = (extra: Partial<OneShotModelRequest> = {}): OneShotModelRequest => ({
  prompt: 'p',
  provider: 'anthropic',
  model: 'haiku',
  thinkingModelId: 'claude-haiku',
  env: { A: '1' },
  ...extra,
});
const runtime = { cliPath: '/cli', executable: undefined };
const assistant = (...texts: string[]) =>
  ({
    type: 'assistant',
    message: { content: texts.map((text) => ({ type: 'text', text })) },
  }) as unknown as SDKMessage;
async function* stream(...messages: SDKMessage[]) {
  yield* messages;
}

describe('buildOneShotQueryOptions', () => {
  test('builds a tool-free single-turn query with the request env', () => {
    const options = buildOneShotQueryOptions(request(), runtime);
    expect(options).toMatchObject({
      model: 'haiku',
      maxTurns: 1,
      tools: [],
      mcpServers: {},
      settingSources: [],
      pathToClaudeCodeExecutable: '/cli',
      env: { A: '1' },
      thinking: { type: 'disabled' },
    });
    expect(options.abortController).toBeUndefined();
  });

  test('resolves Kimi thinking from the thinking model id', () => {
    const thinking = (thinkingModelId: string) =>
      buildOneShotQueryOptions(request({ provider: 'kimi', thinkingModelId }), runtime).thinking;
    expect(thinking('kimi-for-coding')).toEqual({ type: 'enabled', budgetTokens: 16_000 });
    expect(thinking('kimi-k3')).toBeUndefined();
    expect(thinking('moonshot-v1')).toEqual({ type: 'disabled' });
  });

  test('sets a working directory only when one is given', () => {
    expect(buildOneShotQueryOptions(request(), runtime).cwd).toBeUndefined();
    expect(buildOneShotQueryOptions(request({ cwd: '/lean' }), runtime).cwd).toBe('/lean');
  });

  test('passes an abort controller through', () => {
    const abortController = new AbortController();
    expect(buildOneShotQueryOptions(request({ abortController }), runtime).abortController).toBe(
      abortController
    );
  });
});

describe('firstAssistantText', () => {
  test.each([
    ['joins text blocks with a space', [assistant('a', 'b')], undefined, 'a b'],
    ['joins with a custom separator', [assistant('a', 'b')], '\n', 'a\nb'],
    ['skips blank assistant messages', [assistant(' '), assistant('next')], undefined, 'next'],
    ['returns null without assistant text', [{ type: 'result' } as SDKMessage], undefined, null],
    [
      'skips an assistant message without content',
      [{ type: 'assistant', message: {} } as unknown as SDKMessage, assistant('next')],
      undefined,
      'next',
    ],
  ] as const)('%s', async (_label, messages, separator, expected) => {
    expect(await firstAssistantText(stream(...messages), separator)).toBe(expected);
  });
});

describe('runOneShotModel', () => {
  test('sends the prompt and options to the query and returns the first assistant text', async () => {
    const calls: Array<{ prompt: unknown; options?: { model?: string } }> = [];
    const text = await runOneShotModel(
      request({
        query: ((params: { prompt: unknown; options?: { model?: string } }) => {
          calls.push(params);
          return stream(assistant('answer'));
        }) as unknown as OneShotModelRequest['query'],
      })
    );
    expect(text).toBe('answer');
    expect(calls.map(({ prompt, options }) => [prompt, options?.model])).toEqual([['p', 'haiku']]);
  });

  test('returns null, not undefined, when the model sends no text', async () => {
    const text = await runOneShotModel(
      request({
        query: (() =>
          stream({ type: 'result' } as SDKMessage)) as unknown as OneShotModelRequest['query'],
      })
    );
    expect(text).toBeNull();
  });
});

describe('oneShotModelIds', () => {
  test.each([
    ['glm routes through the haiku alias', 'glm', 'glm-5', { ANTHROPIC_MODEL: 'glm-5' }, 'haiku'],
    ['a provider-mapped SDK model wins', 'codex', 'gpt-6', { ANTHROPIC_MODEL: 'sonnet' }, 'sonnet'],
    ['the provider model is used as is', 'anthropic', 'claude-sonnet-5', {}, 'claude-sonnet-5'],
  ] as const)('%s', (_label, provider, modelId, env, model) => {
    expect(oneShotModelIds(provider, modelId, env)).toEqual({ model, thinkingModelId: modelId });
  });
});
