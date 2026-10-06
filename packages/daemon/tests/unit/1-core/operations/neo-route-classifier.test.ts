import { describe, expect, test } from 'bun:test';
import {
  buildNeoRoutePrompt,
  readNeoRouteAnswer,
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
    expect(prompt).toContain('exactly one of these ids and nothing else: main, drivers, youtube');
    expect(prompt).toContain('If it answers a WAITING ON YOU question, that topic.');
  });

  test('keeps the end of a long message where the question usually is', () => {
    const prompt = buildNeoRoutePrompt(`${'x'.repeat(5_000)} so which PR?`, [drivers], '');
    expect(prompt).toContain('so which PR?');
  });
});

describe('readNeoRouteAnswer', () => {
  test('accepts main or a listed id, and nothing else', () => {
    expect(readNeoRouteAnswer(' `drivers` ', [drivers, youtube])).toBe(drivers);
    expect(readNeoRouteAnswer('"main"', [drivers, youtube])).toBe('main');
    expect(readNeoRouteAnswer('garden', [drivers])).toBeNull();
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
    expect(route).toMatchObject({ concernId: 'youtube', signal: 'classifier' });
  });

  test('stays with main Neo when the classifier says main or fails', async () => {
    expect(
      await chooseNeoRoute(
        'which one?',
        deps(async () => 'main')
      )
    ).toBeNull();
    expect(
      await chooseNeoRoute(
        'which one?',
        deps(async () => null)
      )
    ).toBeNull();
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
    expect(route).toMatchObject({
      concernId: NEO_INBOX_ID,
      sessionId: 'neo:inbox',
      signal: 'classifier',
    });
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
    expect([route, embedded]).toEqual([null, []]);
  });
});
