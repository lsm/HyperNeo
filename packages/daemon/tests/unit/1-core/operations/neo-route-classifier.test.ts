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
  neoNewProject,
  openNeoNewProject,
} from '../../../../src/lib/neo/router.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import type { NeoRoute } from '../../../../src/storage/repositories/neo-routing-log-repository.ts';

const drivers: NeoHolder = {
  projectId: 'drivers',
  sessionId: 'neo:holder:drivers',
  title: 'Neo driver epic',
  summary: 'Work drivers for Codex and Claude',
};
const youtube: NeoHolder = {
  projectId: 'youtube',
  sessionId: 'neo:holder:yt',
  title: 'YouTube pipeline',
  summary: '',
};

describe('buildNeoRoutePrompt', () => {
  test('puts the conversation context before the new message and lists the allowed ids', () => {
    const prompt = buildNeoRoutePrompt(
      'how about 5060 now?',
      [drivers, youtube],
      'Projects:\n- main: Neo itself, the default'
    );
    expect(prompt.indexOf('Projects:')).toBeLessThan(
      prompt.indexOf('New message:\nhow about 5060 now?')
    );
    expect(prompt).toContain('Reply with one JSON object and nothing else');
    expect(prompt).toContain('choice is one of: main, drivers, youtube');
    expect(prompt).toContain('answers_waiting: it answers a WAITING ON YOU question');
    expect(prompt.indexOf('- answers_waiting:')).toBeLessThan(prompt.indexOf('- continues_turn:'));
    expect(prompt).toContain("Choose main only when it replies to main's last message.");
    expect(prompt).toContain('cross_project: it asks about work across projects');
    expect(prompt).toContain('basis is the name of the rule below, exactly as written');
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

  test('reads a cross-project question as main', () => {
    expect(
      readNeoRouteDecision('{"choice":"main","confidence":0.7,"basis":"cross_project"}', [youtube])
    ).toEqual({ decision: 'main', confidence: 0.7, basis: 'cross_project' });
  });

  test('keeps the rule when the model explains its basis after it', () => {
    expect(
      readNeoRouteDecision(
        '{"choice":"youtube","confidence":0.9,"basis":"continues_turn: a follow-up to the last turn"}',
        [youtube]
      )
    ).toEqual({ decision: youtube, confidence: 0.9, basis: 'continues_turn' });
    expect(readNeoRouteDecision('{"choice":"main","basis":"one_offish"}', [youtube])).toEqual({
      decision: 'main',
      confidence: null,
      basis: null,
    });
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
  projectId: 'youtube',
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
    projectTurns: () => recent,
    recentAsks: () => [],
    embed: async () => null,
    classify,
  });

  test('routes a next-day "yes" to the project waiting on the user', async () => {
    const seen: string[] = [];
    const route = await chooseNeoRoute(
      'yes',
      deps(async (_text, options, context) => {
        seen.push(options.map((holder) => holder.projectId).join(','));
        return context.includes('WAITING ON YOU: "Draft a reply?"') ? youtube : 'main';
      })
    );
    expect(seen).toEqual(['drivers,youtube']);
    expect(route.choice).toMatchObject({ projectId: 'youtube', signal: 'classifier' });
  });

  test('records the confidence the classifier gave with its decision', async () => {
    const route = await chooseNeoRoute(
      'yes',
      deps(async () => ({ decision: youtube, confidence: 0.91, basis: 'answers_waiting' }))
    );
    expect(route.choice).toMatchObject({
      projectId: 'youtube',
      confidence: 0.91,
      signal: 'classifier:answers_waiting',
    });
    const main = await chooseNeoRoute(
      'new thing',
      deps(async () => ({ decision: 'main', confidence: 0.7, basis: 'new_subject' }))
    );
    expect(main).toEqual({ choice: null, fallback: 'classifier:new_subject' });
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

describe('chooseNeoRoute with a new subject', () => {
  const base = (newProject?: NeoRouterDeps['newProject']): NeoRouterDeps => ({
    holders: () => [drivers, youtube],
    recentTurns: () => [turn({})],
    projectTurns: () => [turn({})],
    recentAsks: () => [],
    embed: async () => null,
    classify: async () => ({ decision: 'main', confidence: 0.8, basis: 'new_subject' }),
    newProject,
  });

  test('opens a project for a new subject and routes the message to its holder', async () => {
    const asked: string[] = [];
    const route = await chooseNeoRoute(
      'Plan the garden for spring',
      base(async (text) => {
        asked.push(text);
        return { projectId: 't1', sessionId: 'neo:t1', title: text, summary: '' };
      })
    );
    expect(asked).toEqual(['Plan the garden for spring']);
    expect(route).toEqual({
      choice: {
        projectId: 't1',
        sessionId: 'neo:t1',
        signal: 'classifier:new_subject',
        confidence: 0.8,
      },
    });
  });

  test('opens a project when the classifier matches a project but names no holder', async () => {
    const route = await chooseNeoRoute('fix HyperNeo #5554', {
      ...base(async () => ({ projectId: 't4', sessionId: 'neo:t4', title: 'fix', summary: '' })),
      classify: async () => ({ decision: 'main', confidence: 0.7, basis: 'matches_project' }),
    });
    expect(route.choice).toMatchObject({
      projectId: 't4',
      signal: 'classifier:matches_project',
      confidence: 0.7,
    });
  });

  test('stays with main Neo when no project can be opened', async () => {
    expect(
      await chooseNeoRoute(
        'Plan the garden',
        base(async () => null)
      )
    ).toEqual({
      choice: null,
      fallback: 'classifier:new_subject',
    });
    expect(await chooseNeoRoute('Plan the garden', base())).toEqual({
      choice: null,
      fallback: 'classifier:new_subject',
    });
  });

  const projectDb = () => {
    const db = new Sqlite(':memory:');
    createTables(db);
    return { db, repo: new NeoRepository(db) };
  };

  test('saves the project once and reopens the same holder on a retry', async () => {
    const { db, repo } = projectDb();
    const opened: string[] = [];
    const open = async (id: string) => {
      opened.push(id);
      return `neo:${id}`;
    };
    const project = neoNewProject('Plan the garden', 'request-1');
    const holder = {
      projectId: 'request-1',
      sessionId: 'neo:request-1',
      title: 'Plan the garden',
      summary: 'Plan the garden',
    };
    expect(await openNeoNewProject(repo, open, project)).toEqual(holder);
    expect(await openNeoNewProject(repo, open, { ...project, title: 'Other' })).toEqual(holder);
    expect(repo.listProjects().map((project) => project.id)).toEqual(['request-1']);
    expect(opened).toEqual(['request-1', 'request-1']);
    db.close();
  });

  test('drops a project whose holder cannot be opened, so the message stays with main Neo', async () => {
    const { db, repo } = projectDb();
    expect(
      await openNeoNewProject(
        repo,
        async () => {
          throw new Error('provider unavailable');
        },
        neoNewProject('Plan the garden', 't2')
      )
    ).toBeNull();
    expect(
      await openNeoNewProject(
        repo,
        async (id) => {
          repo.reserveBinding({ sessionId: `neo:${id}`, projectId: id, kind: 'project' });
          throw new Error('session could not be created');
        },
        neoNewProject('Plan the pond', 't3')
      )
    ).toBeNull();
    expect([repo.getProject('t2'), repo.getProject('t3'), repo.getBindingForProject('t3')]).toEqual(
      [null, null, null]
    );
    db.close();
  });

  test('names the project after the first line of the message', () => {
    expect(neoNewProject('  Plan the garden\nwith tomatoes  ', 'id-1')).toEqual({
      id: 'id-1',
      title: 'Plan the garden',
      summary: 'Plan the garden with tomatoes',
    });
    expect(neoNewProject('x'.repeat(80), 'id-2').title).toBe(`${'x'.repeat(59)}…`);
  });
});

describe('chooseNeoRoute with an inbox', () => {
  const inboxHolder = {
    projectId: NEO_INBOX_ID,
    sessionId: 'neo:inbox',
    title: 'Inbox',
    summary: '',
  };

  test('offers the inbox to the classifier and opens it only when chosen', async () => {
    let opened = 0;
    const offered: string[][] = [];
    const route = await chooseNeoRoute('what time is it in Tokyo?', {
      holders: () => [],
      recentTurns: () => [turn({ destination: 'main', projectId: null, awaiting: null })],
      projectTurns: () => [],
      recentAsks: () => [],
      embed: async () => null,
      classify: async (_text, options) => {
        offered.push(options.map((holder) => holder.projectId));
        return options.find((holder) => holder.projectId === NEO_INBOX_ID) ?? null;
      },
      inbox: async () => {
        opened += 1;
        return inboxHolder;
      },
    });
    expect(offered).toEqual([[NEO_INBOX_ID]]);
    expect(opened).toBe(1);
    expect(route.choice).toMatchObject({
      projectId: NEO_INBOX_ID,
      sessionId: 'neo:inbox',
      signal: 'classifier',
    });
  });

  test('does not offer an inbox that cannot run', async () => {
    const offered: string[][] = [];
    let opened = 0;
    const route = await chooseNeoRoute('what time is it in Tokyo?', {
      holders: () => [drivers],
      recentTurns: () => [turn({ destination: 'main', projectId: null, awaiting: null })],
      projectTurns: () => [],
      recentAsks: () => [],
      embed: async () => null,
      classify: async (_text, options) => {
        offered.push(options.map((holder) => holder.projectId));
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
      projectTurns: () => [],
      recentAsks: () => [],
      embed: async (text) => {
        embedded.push(text);
        return Float32Array.from([1, 0]);
      },
    });
    expect([route.choice, embedded]).toEqual([null, []]);
  });
});
