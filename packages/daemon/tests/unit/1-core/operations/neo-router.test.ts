import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import {
  askNeoRouteModel,
  chooseNeoRoute,
  type NeoHolder,
  type NeoRouteVerdict,
  type NeoRouterDeps,
  neoHolderProfile,
  neoRouteCandidateLine,
  pickNeoHolder,
  renderNeoRouteContext,
  runnableNeoHolders,
  scoreNeoHolders,
  reopenNeoHolder,
  wakeNeoRoute,
} from '../../../../src/lib/neo/router.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  type NeoRoute,
  NeoRoutingLogRepository,
} from '../../../../src/storage/repositories/neo-routing-log-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';

const drivers: NeoHolder = {
  projectId: 'drivers',
  sessionId: 'neo:holder:drivers',
  title: 'Neo driver epic',
  summary: 'drivers',
};
const youtube: NeoHolder = {
  ...drivers,
  projectId: 'youtube',
  sessionId: 'neo:holder:yt',
  title: 'YouTube',
};
const route = (fields: Partial<NeoRoute>): NeoRoute => ({
  id: 1,
  messageId: 'm',
  conversationId: 'c',
  askedAt: 1_000,
  ask: 'a',
  destination: 'holder',
  targetSessionId: drivers.sessionId,
  projectId: 'drivers',
  signal: 'embedding',
  confidence: 0.8,
  outcome: null,
  outcomeAt: null,
  askSummary: null,
  awaiting: null,
  ...fields,
});

describe('neoHolderProfile', () => {
  test('trims each recent ask so one long ask cannot swamp the profile', () => {
    const profile = neoHolderProfile(
      { projectId: 'drivers', sessionId: 's', title: 'Drivers', summary: 'Work adapters' },
      [`${'z'.repeat(9_000)} end`, 'short ask']
    );
    expect(profile.split('\n')).toHaveLength(4);
    expect(profile.split('\n')[2]).toHaveLength(300);
    expect(profile).toContain('short ask');
  });
});

describe('pickNeoHolder', () => {
  test('picks a holder only when it is close enough and clearly ahead', () => {
    expect(
      pickNeoHolder([
        { holder: drivers, similarity: 0.7 },
        { holder: youtube, similarity: 0.6 },
      ])
    ).toMatchObject({ projectId: 'drivers', confidence: 0.7 });
    expect(
      pickNeoHolder([
        { holder: drivers, similarity: 0.7 },
        { holder: youtube, similarity: 0.68 },
      ])
    ).toBeNull();
    expect(pickNeoHolder([{ holder: drivers, similarity: 0.5 }])).toBeNull();
  });
});

describe('renderNeoRouteContext', () => {
  test("lists main, topics with their last turn and waiting question, then the topics' recent turns", () => {
    const pr = route({
      id: 2,
      destination: 'main',
      projectId: null,
      ask: 'is the font-size PR done?',
      outcome: 'Still in review.',
    });
    const blog = route({
      id: 1,
      projectId: 'youtube',
      ask: 'https://example.com long ask',
      askSummary: 'What is the post?',
      outcome: 'A git beta.',
      awaiting: 'Draft a reply?',
    });
    const context = renderNeoRouteContext([drivers, youtube], [pr, blog], [pr, blog], true);
    expect(context).toContain(
      '- main: Neo itself, the last resort for questions across projects or when you cannot tell\n    last: [main] you: "is the font-size PR done?" → Still in review.'
    );
    expect(context).toContain('- youtube: YouTube (drivers)\n    WAITING ON YOU: "Draft a reply?"');
    expect(context).toContain('- inbox: Self-contained one-off questions');
    expect(context.split('Recent turns (newest first):\n')[1]).toBe(
      '- [YouTube] you: "What is the post?" → A git beta.'
    );
  });

  test('lists every topic on one line, however many there are', () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ ...drivers, projectId: `t${n}` }));
    const projects = renderNeoRouteContext(many, [], [], false)
      .split('Recent turns')[0]
      .split('\n')
      .filter((line) => line.startsWith('- t'));
    expect(projects).toHaveLength(40);
  });

  test('keeps recent turns within the budget', () => {
    const many = Array.from({ length: 40 }, (_, n) => route({ id: n, ask: 'q'.repeat(300) }));
    const turns = renderNeoRouteContext([drivers], many, [], false)
      .split('Recent turns (newest first):\n')[1]
      .split('\n');
    expect(turns.length).toBeLessThan(40);
    expect(turns.join('\n').length).toBeLessThanOrEqual(3_000);
  });
});

describe('runnableNeoHolders', () => {
  test('drops holders whose provider cannot run, keeping unknown ones', () => {
    const glm = { ...drivers, provider: 'glm' };
    const opus = { ...youtube, provider: 'anthropic' };
    const unset = { ...drivers, projectId: 'legacy' };
    expect(
      runnableNeoHolders(
        [glm, opus, unset],
        new Map([
          ['glm', true],
          ['anthropic', false],
        ])
      ).map((holder) => holder.projectId)
    ).toEqual(['drivers']);
    expect(runnableNeoHolders([glm], new Map()).map((holder) => holder.projectId)).toEqual([
      'drivers',
    ]);
  });
});

describe('neoRouteCandidateLine', () => {
  test('names the topic with its repository and summary', () => {
    expect(neoRouteCandidateLine({ ...drivers, repository: 'lsm/neo-ios' })).toBe(
      '- drivers: Neo driver epic [lsm/neo-ios] (drivers)'
    );
    expect(neoRouteCandidateLine({ ...drivers, summary: '' })).toBe('- drivers: Neo driver epic');
  });
});

describe('askNeoRouteModel', () => {
  const answering = (answers: NeoRouteVerdict[]) => {
    const calls: number[] = [];
    const deps = {
      classify: async () => {
        calls.push(calls.length);
        return answers[calls.length - 1] ?? null;
      },
    };
    return { deps, calls };
  };

  test.each(['timeout', 'failed', null] as const)(
    'asks once more when the route model gives %s',
    async (first) => {
      const { deps, calls } = answering([first, drivers]);
      expect(await askNeoRouteModel('hi', [drivers], 'ctx', false, deps)).toEqual(drivers);
      expect(calls).toHaveLength(2);
    }
  );

  test('keeps an answer without retrying, and retries only once', async () => {
    const answered = answering(['main']);
    expect(await askNeoRouteModel('hi', [drivers], 'ctx', false, answered.deps)).toBe('main');
    expect(answered.calls).toHaveLength(1);
    const silent = answering(['timeout', 'failed']);
    expect(await askNeoRouteModel('hi', [drivers], 'ctx', false, silent.deps)).toBe('failed');
    expect(silent.calls).toHaveLength(2);
  });

  test('offers the inbox to the route model when it is runnable', async () => {
    const offered: string[][] = [];
    await askNeoRouteModel('hi', [drivers], 'ctx', true, {
      classify: async (_text, options) => {
        offered.push(options.map((option) => option.projectId));
        return 'main';
      },
    });
    expect(offered).toEqual([['drivers', 'inbox']]);
    expect(await askNeoRouteModel('hi', [drivers], 'ctx', true, {})).toBeNull();
  });
});

describe('chooseNeoRoute', () => {
  const vectors: Record<string, number[]> = {
    'restart the daemon after the driver merge': [1, 0, 0],
    'Neo driver epic\ndrivers': [0.95, 0.05, 0],
    'YouTube\ndrivers': [0, 1, 0],
  };
  const deps = (recent: NeoRoute[] = []): NeoRouterDeps => ({
    holders: () => [drivers, youtube],
    recentTurns: () => recent,
    projectTurns: () => recent.slice(0, 1),
    recentAsks: () => [],
    embed: async (text) => (vectors[text] ? Float32Array.from(vectors[text]) : null),
  });

  test('falls back to a clear embedding match when no classifier answers', async () => {
    expect(
      (await chooseNeoRoute('restart the daemon after the driver merge', deps())).choice
    ).toMatchObject({ projectId: 'drivers', signal: 'embedding' });
    expect((await chooseNeoRoute('unknown text', deps())).choice).toBeNull();
  });

  test('sends a follow-up to main when the classifier reads it as continuing main', async () => {
    const recent = [route({ destination: 'main', projectId: null, ask: 'is PR 5650 done?' })];
    const seen: string[] = [];
    const choice = await chooseNeoRoute('how about 5060 now?', {
      ...deps(recent),
      classify: async (_text, _options, context) => {
        seen.push(context);
        return 'main';
      },
    });
    expect(choice).toEqual({ choice: null, fallback: 'classifier' });
    expect(seen[0]).toContain('[main] you: "is PR 5650 done?"');
  });

  test('offers the classifier every topic without recent turns or embeddings', async () => {
    const many = Array.from({ length: 30 }, (_, n) => ({ ...drivers, projectId: `t${n}` }));
    const offered: string[][] = [];
    await chooseNeoRoute('what changed in t29?', {
      ...deps(),
      holders: () => many,
      embed: async () => null,
      classify: async (_text, options) => {
        offered.push(options.map((option) => option.projectId));
        return 'main';
      },
    });
    expect(offered[0]).toEqual(many.map((holder) => holder.projectId));
  });

  test('skips the classifier when there are no topics and no history', async () => {
    let asked = 0;
    const choice = await chooseNeoRoute('anything', {
      ...deps(),
      holders: () => [],
      classify: async () => {
        asked += 1;
        return 'main';
      },
    });
    expect([choice, asked]).toEqual([{ choice: null }, 0]);
  });
});

describe('wakeNeoRoute', () => {
  const choice = {
    projectId: 'drivers',
    sessionId: drivers.sessionId,
    signal: 'embedding' as const,
    confidence: 0.8,
  };

  test('leaves a route to an awake holder or to main Neo alone', async () => {
    const asleep = () => false;
    expect(await wakeNeoRoute({ choice }, { asleep })).toEqual({ choice });
    expect(
      await wakeNeoRoute({ choice: null, fallback: 'classifier' }, { asleep: () => true })
    ).toEqual({ choice: null, fallback: 'classifier' });
  });

  test('wakes a sleeping holder and delivers to its new session', async () => {
    const woken: string[] = [];
    const routed = await wakeNeoRoute(
      { choice },
      {
        asleep: (id) => id === drivers.sessionId,
        wake: async (projectId) => {
          woken.push(projectId);
          return 'neo:holder:drivers-2';
        },
      }
    );
    expect(woken).toEqual(['drivers']);
    expect(routed).toEqual({ choice: { ...choice, sessionId: 'neo:holder:drivers-2' } });
  });

  test('says why when a sleeping holder cannot be woken', async () => {
    const asleep = () => true;
    expect(await wakeNeoRoute({ choice }, { asleep, wake: async () => null })).toEqual({
      choice: null,
      fallback: 'holder-unavailable',
    });
    expect(await wakeNeoRoute({ choice }, { asleep })).toEqual({
      choice: null,
      fallback: 'holder-unavailable',
    });
  });
});

describe('neo.message.send with a router', () => {
  const conversationId = '10000000-0000-4000-8000-000000000001';
  const root: NeoBinding = { sessionId: `neo:${conversationId}`, kind: 'neo', projectId: null };
  const holder: NeoBinding = {
    sessionId: drivers.sessionId,
    kind: 'project',
    projectId: 'drivers',
  };
  const ask = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let directory: string;
  let writer: Sqlite;
  let db: Database;
  let repo: NeoRepository;
  let sdk: SDKMessageRepository;
  let calls: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-router-'));
    writer = new Sqlite(join(directory, 'fictional.db'));
    createTables(writer);
    const sessions = new SessionRepository(writer);
    sdk = new SDKMessageRepository(writer as never);
    const jobs = new JobQueueRepository(writer);
    repo = new NeoRepository(writer);
    calls = [];
    for (const binding of [root, holder]) {
      repo.reserveBinding(binding);
      sessions.createSession({
        id: binding.sessionId,
        title: 'Fictional',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {},
        metadata: {},
      } as Session);
    }
    db = {
      getDatabase: () => writer,
      getSDKMessageRepo: () => sdk,
      getJobQueueRepo: () => jobs,
      getSession: (id: string) => sessions.getSession(id),
    } as unknown as Database;
  });
  afterEach(() => {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const send = (sessionId: string, requestId: string, content: string) =>
    invokeOperation(
      createOperationRegistry([
        createNeoIntakeOperation(
          db,
          repo,
          () => {},
          async (text) => {
            calls.push(text);
            return text.includes('driver')
              ? {
                  choice: {
                    projectId: 'drivers',
                    sessionId: drivers.sessionId,
                    signal: 'embedding',
                    confidence: 0.71,
                  },
                }
              : { choice: null, fallback: 'classifier-timeout' };
          }
        ),
      ]),
      'neo.message.send',
      { sessionId, requestId, content },
      { source: 'rpc', principal: 'local' }
    );
  const delivered = (sessionId: string, requestId: string) =>
    sdk.getDeliveryMessageIdsByUuids(sessionId, [requestId]).length;

  test('delivers a confident ask to the holder and logs why', async () => {
    await send(root.sessionId, ask(1), 'merge the driver PR');
    expect([delivered(holder.sessionId, ask(1)), delivered(root.sessionId, ask(1))]).toEqual([
      1, 0,
    ]);
    expect(new NeoRoutingLogRepository(writer).find(ask(1))).toMatchObject({
      destination: 'holder',
      projectId: 'drivers',
      signal: 'embedding',
      confidence: 0.71,
    });
  });

  test('keeps an unsure ask with main Neo and reuses the first route on retry', async () => {
    await send(root.sessionId, ask(2), 'weather tomorrow?');
    expect(delivered(root.sessionId, ask(2))).toBe(1);
    expect(new NeoRoutingLogRepository(writer).find(ask(2))).toMatchObject({
      destination: 'main',
      signal: 'classifier-timeout',
    });
    await send(root.sessionId, ask(3), 'merge the driver PR');
    await send(root.sessionId, ask(3), 'merge the driver PR');
    expect(calls).toEqual(['weather tomorrow?', 'merge the driver PR']);
    expect(delivered(holder.sessionId, ask(3))).toBe(1);
  });

  test('queues an ask for a holder that is busy with another turn', async () => {
    new SessionRepository(writer).updateSession(holder.sessionId, {
      processingState: JSON.stringify({ status: 'processing', messageId: 'other' }),
    });
    await send(root.sessionId, ask(5), 'merge the driver PR');
    expect([delivered(holder.sessionId, ask(5)), delivered(root.sessionId, ask(5))]).toEqual([
      1, 0,
    ]);
  });

  test('reopens an archived holder on a fresh session, and a live one as it is', async () => {
    const opened: string[] = [];
    const open = async (projectId: string) => {
      opened.push(projectId);
      return repo.getBindingForProject(projectId)?.sessionId ?? 'neo:fresh';
    };
    expect(await reopenNeoHolder(repo, db, open, 'drivers')).toBe(holder.sessionId);
    new SessionRepository(writer).updateSession(holder.sessionId, { status: 'archived' });
    expect(await reopenNeoHolder(repo, db, open, 'drivers')).toBe('neo:fresh');
    expect(opened).toEqual(['drivers', 'drivers']);
  });

  test('retires the binding of an archived holder so the next open makes a fresh session', () => {
    expect(repo.retireArchivedBinding('drivers', 'neo:other')).toBe(false);
    expect(repo.retireArchivedBinding('drivers', holder.sessionId)).toBe(true);
    expect(repo.getBindingForProject('drivers')).toBeNull();
    expect(repo.getBindingForProject(null)).toMatchObject({ sessionId: root.sessionId });
  });

  test('does not reroute an ask sent to a holder directly', async () => {
    await send(holder.sessionId, ask(4), 'weather tomorrow?');
    expect(calls).toEqual([]);
    expect(delivered(holder.sessionId, ask(4))).toBe(1);
  });
});

describe('scoreNeoHolders', () => {
  test('keeps a bounded number of holder profile vectors, dropping the least recently used', async () => {
    const prefix = `cap-${Date.now()}`;
    const holders: NeoHolder[] = Array.from({ length: 257 }, (_, index) => ({
      projectId: `c${index}`,
      sessionId: `s${index}`,
      title: `${prefix} topic ${index}`,
      summary: '',
    }));
    const embedded: string[] = [];
    const deps = {
      recentAsks: () => [],
      embed: async (text: string) => {
        embedded.push(text);
        return new Float32Array([1, 0]);
      },
    } as unknown as NeoRouterDeps;

    await scoreNeoHolders('ask', holders, deps);
    embedded.length = 0;
    await scoreNeoHolders('ask', [holders[256], holders[0]], deps);

    expect(embedded).toEqual(['ask', `${prefix} topic 0`]);
  });
});
