import { describe, expect, test } from 'bun:test';
import {
  buildNeoRoutePrompt,
  neoRouteEndpoint,
  neoRouteTimeoutMs,
  neoRouteHttpCall,
  readNeoRouteDecision,
  readNeoRouteStream,
} from '../../../../src/lib/neo/route-classifier.ts';
import {
  chooseNeoRoute,
  NEO_INBOX_ID,
  type NeoHolder,
  type NeoRouterDeps,
} from '../../../../src/lib/neo/router.ts';
import type { NeoRoute } from '../../../../src/storage/repositories/neo-routing-log-repository.ts';

const drivers: NeoHolder = {
  concernId: 'drivers',
  sessionId: 'neo:holder:drivers',
  title: 'Neo driver epic',
  summary: 'Work drivers for Codex and Claude',
};
const youtube: NeoHolder = {
  concernId: 'youtube',
  sessionId: 'neo:holder:yt',
  title: 'YouTube pipeline',
  summary: '',
};

describe('buildNeoRoutePrompt', () => {
  test('puts the conversation context before the new message and lists the allowed ids', () => {
    const prompt = buildNeoRoutePrompt(
      'how about 5060 now?',
      [drivers, youtube],
      'Topics:\n- main: Neo itself, the default'
    );
    expect(prompt.indexOf('Topics:')).toBeLessThan(
      prompt.indexOf('New message:\nhow about 5060 now?')
    );
    expect(prompt).toContain('Reply with one JSON object and nothing else');
    expect(prompt).toContain('choice is one of: main, drivers, youtube');
    expect(prompt).toContain('answers_waiting: it answers a WAITING ON YOU question');
  });

  test('keeps the end of a long message where the question usually is', () => {
    const prompt = buildNeoRoutePrompt(`${'x'.repeat(5_000)} so which PR?`, [drivers], '');
    expect(prompt).toContain('so which PR?');
  });
});

describe('neoRouteHttpCall', () => {
  test('calls a third-party endpoint directly with thinking off and a tiny answer budget', () => {
    expect(
      neoRouteHttpCall(
        'https://api.deepseek.com/anthropic/',
        'deepseek-v4-flash',
        { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: neo\nbad line' },
        'route this',
        { type: 'disabled' }
      )
    ).toEqual({
      url: 'https://api.deepseek.com/anthropic/v1/messages',
      headers: {
        'X-Team': 'neo',
        authorization: 'Bearer tok',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'deepseek-v4-flash',
        max_tokens: 512,
        stream: true,
        messages: [{ role: 'user', content: 'route this' }],
        thinking: { type: 'disabled' },
      },
    });
  });

  test('keeps a required thinking budget, uses an API key, and leaves Anthropic to the SDK', () => {
    const call = neoRouteHttpCall(
      'http://127.0.0.1:4000',
      'kimi-k2.7',
      { ANTHROPIC_API_KEY: 'key' },
      'p',
      { type: 'enabled', budgetTokens: 16_000 }
    );
    expect(call?.headers['x-api-key']).toBe('key');
    expect(call?.body).toMatchObject({
      max_tokens: 16_512,
      thinking: { type: 'enabled', budget_tokens: 16_000 },
    });
    expect(
      neoRouteHttpCall('https://api.anthropic.com', 'claude-haiku-4-5', {}, 'p', undefined)
    ).toBeNull();
    expect(neoRouteHttpCall('not a url', 'm', {}, 'p', undefined)).toBeNull();
  });
});

describe('neoRouteTimeoutMs', () => {
  it('uses the saved timeout and falls back to 15 s when unset or invalid', () => {
    expect(neoRouteTimeoutMs(30_000)).toBe(30_000);
    expect(neoRouteTimeoutMs(undefined)).toBe(15_000);
    expect(neoRouteTimeoutMs(0)).toBe(15_000);
    expect(neoRouteTimeoutMs(Number.NaN)).toBe(15_000);
  });
});

describe('neoRouteEndpoint', () => {
  test('uses the title model by default and the configured model from its provider env', () => {
    const title = { modelId: 'glm-4.7-air', baseUrl: 'https://open.bigmodel.cn/api/anthropic' };
    expect(neoRouteEndpoint(title, 'glm-4.7-air', {})).toBe(title);
    expect(
      neoRouteEndpoint(null, 'deepseek-v4-flash', {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      })
    ).toEqual({ modelId: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/anthropic' });
    expect(neoRouteEndpoint(null, 'claude-haiku-4-5', { ANTHROPIC_MODEL: '' })).toEqual({
      modelId: 'claude-haiku-4-5',
      baseUrl: 'https://api.anthropic.com',
    });
  });
});

describe('readNeoRouteStream', () => {
  test('joins the text deltas of a streamed answer', () => {
    const stream = [
      'event: message_start',
      'data: {"type":"message_start"}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"you"}}',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"tube"}}',
      'data: not json',
    ].join('\n');
    expect(readNeoRouteStream(stream)).toBe('youtube');
  });
});

describe('readNeoRouteDecision', () => {
  test('reads a JSON choice with its confidence and basis', () => {
    expect(
      readNeoRouteDecision(
        '{"type":"choice","choice":"youtube","confidence":0.82,"basis":"answers_waiting"}',
        [drivers, youtube]
      )
    ).toEqual({ decision: youtube, confidence: 0.82, basis: 'answers_waiting' });
    expect(
      readNeoRouteDecision('```json\n{"choice":"main","confidence":3,"basis":"guess"}\n```', [
        drivers,
      ])
    ).toEqual({ decision: 'main', confidence: 1, basis: null });
  });

  test('still accepts a bare id, and rejects an id that was not offered', () => {
    expect(readNeoRouteDecision(' `drivers` ', [drivers, youtube])).toEqual({
      decision: drivers,
      confidence: null,
      basis: null,
    });
    expect(readNeoRouteDecision('{"choice":"garden"}', [drivers])).toBeNull();
    expect(readNeoRouteDecision('garden', [drivers])).toBeNull();
    expect(readNeoRouteDecision('', [drivers])).toBeNull();
  });
});

const turn = (fields: Partial<NeoRoute>): NeoRoute => ({
  id: 1,
  messageId: 'm1',
  conversationId: 'c',
  askedAt: 0,
  ask: 'what is the Cloudflare post?',
  destination: 'holder',
  targetSessionId: youtube.sessionId,
  concernId: 'youtube',
  signal: 'classifier',
  confidence: 0.6,
  outcome: 'A git beta.',
  outcomeAt: 0,
  askSummary: null,
  awaiting: 'Draft a reply?',
  ...fields,
});

describe('chooseNeoRoute with a classifier', () => {
  const deps = (
    classify: NonNullable<NeoRouterDeps['classify']>,
    recent: NeoRoute[] = [turn({})]
  ): NeoRouterDeps => ({
    holders: () => [drivers, youtube],
    recentTurns: () => recent,
    topicTurns: () => recent,
    recentAsks: () => [],
    embed: async () => null,
    classify,
  });

  test('routes a next-day "yes" to the topic waiting on the user', async () => {
    const seen: string[] = [];
    const route = await chooseNeoRoute(
      'yes',
      deps(async (_text, options, context) => {
        seen.push(options.map((holder) => holder.concernId).join(','));
        return context.includes('WAITING ON YOU: "Draft a reply?"') ? youtube : 'main';
      })
    );
    expect(seen).toEqual(['drivers,youtube']);
    expect(route.choice).toMatchObject({ concernId: 'youtube', signal: 'classifier' });
  });

  test('records the confidence the classifier gave with its decision', async () => {
    const route = await chooseNeoRoute(
      'yes',
      deps(async () => ({ decision: youtube, confidence: 0.91, basis: 'answers_waiting' }))
    );
    expect(route.choice).toMatchObject({ concernId: 'youtube', confidence: 0.91 });
    const main = await chooseNeoRoute(
      'new thing',
      deps(async () => ({ decision: 'main', confidence: 0.7, basis: 'new_subject' }))
    );
    expect(main).toEqual({ choice: null, fallback: 'classifier' });
  });

  test('stays with main Neo and records why when the classifier says main or gives no answer', async () => {
    const verdicts = ['main', null, 'timeout', 'failed'] as const;
    const routes = await Promise.all(
      verdicts.map((verdict) =>
        chooseNeoRoute(
          'which one?',
          deps(async () => verdict)
        )
      )
    );
    expect(routes).toEqual([
      { choice: null, fallback: 'classifier' },
      { choice: null, fallback: 'classifier-unanswered' },
      { choice: null, fallback: 'classifier-timeout' },
      { choice: null, fallback: 'classifier-failed' },
    ]);
  });
});

describe('chooseNeoRoute with an inbox', () => {
  const inboxHolder = {
    concernId: NEO_INBOX_ID,
    sessionId: 'neo:inbox',
    title: 'Inbox',
    summary: '',
  };

  test('offers the inbox to the classifier and opens it only when chosen', async () => {
    let opened = 0;
    const offered: string[][] = [];
    const route = await chooseNeoRoute('what time is it in Tokyo?', {
      holders: () => [],
      recentTurns: () => [turn({ destination: 'main', concernId: null, awaiting: null })],
      topicTurns: () => [],
      recentAsks: () => [],
      embed: async () => null,
      classify: async (_text, options) => {
        offered.push(options.map((holder) => holder.concernId));
        return options.find((holder) => holder.concernId === NEO_INBOX_ID) ?? null;
      },
      inbox: async () => {
        opened += 1;
        return inboxHolder;
      },
    });
    expect(offered).toEqual([[NEO_INBOX_ID]]);
    expect(opened).toBe(1);
    expect(route.choice).toMatchObject({
      concernId: NEO_INBOX_ID,
      sessionId: 'neo:inbox',
      signal: 'classifier',
    });
  });

  test('does not offer an inbox that cannot run', async () => {
    const offered: string[][] = [];
    let opened = 0;
    const route = await chooseNeoRoute('what time is it in Tokyo?', {
      holders: () => [drivers],
      recentTurns: () => [turn({ destination: 'main', concernId: null, awaiting: null })],
      topicTurns: () => [],
      recentAsks: () => [],
      embed: async () => null,
      classify: async (_text, options) => {
        offered.push(options.map((holder) => holder.concernId));
        return 'main';
      },
      inbox: async () => {
        opened += 1;
        return inboxHolder;
      },
      inboxRunnable: async () => false,
    });
    expect([route.choice, offered, opened]).toEqual([null, [['drivers']], 0]);
  });

  test('never matches the inbox by embedding', async () => {
    const embedded: string[] = [];
    const route = await chooseNeoRoute('anything', {
      holders: () => [inboxHolder],
      recentTurns: () => [],
      topicTurns: () => [],
      recentAsks: () => [],
      embed: async (text) => {
        embedded.push(text);
        return Float32Array.from([1, 0]);
      },
    });
    expect([route.choice, embedded]).toEqual([null, []]);
  });
});
