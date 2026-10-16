import { requireClaudeReplyDestination } from '../../../../src/lib/drivers/claude-inbox-submit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaudeDesktopAdapterDeps,
  type ClaudeRecordCache,
  type ClaudeLiveSession,
  claudeInputEvidence,
  claudeTranscriptState,
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  readLiveClaudeSessions,
  reuseLiveSessions,
} from '../../../../src/lib/drivers/claude-desktop-adapter';
import { WorkDetailSchema } from '../../../../src/lib/drivers/types';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';

function record(id: string, fields: Record<string, unknown>) {
  return { sessionId: `local_${id}`, cliSessionId: `cli-${id}`, ...fields };
}

const user = { from: 'user', caller: { source: 'rpc' as const } };

describe('claude-desktop adapter against the app session records', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-sessions-'));
    const write = (scope: string, value: Record<string, unknown> | string) => {
      mkdirSync(join(dir, scope), { recursive: true });
      const name =
        typeof value === 'string' ? 'local_broken.json' : `${String(value.sessionId)}.json`;
      writeFileSync(
        join(dir, scope, name),
        typeof value === 'string' ? value : JSON.stringify(value)
      );
    };
    write(
      'acct-a/scope-1',
      record('a1', {
        originCwd: '/focus/dolmen',
        cwd: '/focus/dolmen/.claude/worktrees/w1',
        title: 'lakehouse loader',
        isArchived: false,
        lastActivityAt: 30,
      })
    );
    write(
      'acct-a/scope-1',
      record('a2', {
        originCwd: '/focus/dolmen',
        title: 'old review',
        isArchived: true,
        lastActivityAt: 10,
      })
    );
    write(
      'acct-b/scope-2',
      record('b1', {
        originCwd: '/focus/fiso',
        title: 'fiso init',
        isArchived: true,
        lastActivityAt: 20,
      })
    );
    write(
      'acct-b/scope-2',
      record('b2', { cwd: '/focus/ops', title: 'woodpecker', lastActivityAt: 5 })
    );
    write('acct-b/scope-2', '{not json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  let spawned: Array<{ args: string[]; cwd?: string }>;
  let liveReads = 0;

  function adapter(
    live: ClaudeLiveSession[] | Error = [
      { sessionId: 'cli-a1', status: 'waiting', name: 'lakehouse loader', owner: 'cli', pid: 1 },
    ],
    exitCode = 0,
    onSpawn = () => {},
    output: { stdout?: string; stderr?: string } = { stderr: exitCode ? 'relay failed' : '' },
    sendInbox?: ClaudeDesktopAdapterDeps['sendInbox']
  ) {
    spawned = [];
    return createClaudeDesktopAdapter({
      sendInbox,
      admitInbox: sendInbox
        ? (context) => requireClaudeReplyDestination(context, { hasSession: () => false })
        : undefined,
      sessionsDir: dir,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        liveReads++;
        if (live instanceof Error) throw live;
        return live;
      },
      folderExists: (folder) => folder !== '/gone',
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'unused',
      sleep: async () => {},
      now: () => 0,
      spawn: (args, options) => {
        spawned.push({ args, cwd: options?.cwd });
        onSpawn();
        return {
          stdout: new Response(output.stdout ?? '').body,
          stderr: new Response(output.stderr ?? (exitCode ? 'relay failed' : '')).body,
          exited: Promise.resolve(exitCode),
          exitCode,
          kill: () => {},
        };
      },
    });
  }

  test.each([
    { ok: true as const, value: { delivered: false, unconfirmed: true as const } },
    { ok: false as const, reason: 'unreachable' as const, detail: 'owner changed' },
  ])('uses the injected inbox result without relay fallback (%j)', async (reply) => {
    const calls: unknown[] = [];
    const context = { from: 'session:origin', caller: { source: 'internal' as const } };
    const driver = adapter(undefined, 0, undefined, undefined, async (...args) => {
      calls.push(args);
      return reply;
    });
    expect(
      await driver.send!({ adapter: 'claude-desktop', id: 'local_a1' }, 'exact text', context)
    ).toEqual(reply);
    expect(calls).toEqual([['cli-a1', 'exact text', context]]);
    expect(spawned).toEqual([]);
  });

  test.each(['chat', 'session:missing'])(
    'rejects reply target %s before start effects',
    async (from) => {
      const driver = adapter(undefined, 0, undefined, undefined, async () => {
        throw new Error('not reached');
      });
      const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'd' };
      expect(
        await driver.start!({ place, title: 'new', message: 'task' }, { ...user, from })
      ).toMatchObject({ ok: false, reason: from === 'chat' ? 'unsupported' : 'unreachable' });
      expect(spawned).toEqual([]);
    }
  );

  test('status exposes execution cwd without requiring a transcript', async () => {
    const result = await adapter().status!({ adapter: 'claude-desktop', id: 'local_a1' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(WorkDetailSchema.parse(result.value)).toMatchObject({
      place: { folder: '/focus/dolmen' },
      execution: { directory: '/focus/dolmen/.claude/worktrees/w1', machine: 'laptop' },
    });
  });

  test.each([undefined, '', 'relative/worktree'])(
    'status never substitutes originCwd for unusable execution cwd %s',
    async (cwd) => {
      writeFileSync(
        join(dir, 'acct-a/scope-1/local_a1.json'),
        JSON.stringify(record('a1', { originCwd: '/focus/dolmen', cwd }))
      );
      const result = await adapter().status!({ adapter: 'claude-desktop', id: 'local_a1' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.value.execution).toBeUndefined();
      expect(result.value.place.folder).toBe('/focus/dolmen');
    }
  );

  test('lists every project the app shows, with its open sessions and live status', async () => {
    const groups = await adapter().find({ includeClosed: false, limit: 20 });
    const byName = new Map(groups.map((g) => [g.place.name, g]));
    expect(
      [...byName.values()]
        .map((g) => [g.place.folder, g.openCount, g.archivedCount, g.work.map((w) => w.title)])
        .sort()
    ).toEqual([
      ['/focus/dolmen', 1, 1, ['lakehouse loader']],
      ['/focus/fiso', 0, 1, []],
      ['/focus/ops', 1, 0, ['woodpecker']],
    ]);
    expect(byName.get('dolmen')?.work[0]).toEqual({
      ref: { adapter: 'claude-desktop', id: 'local_a1' },
      title: 'lakehouse loader',
      place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
      status: 'needs_you',
      lastActivityAt: 30,
      link: 'claude://claude.ai/epitaxy/local_a1',
    });
  });

  test('archives only the selected session and preserves its full app record', async () => {
    const path = join(dir, 'acct-a/scope-1/local_a1.json');
    const before = { ...JSON.parse(readFileSync(path, 'utf8')), appMetadata: { keep: true } };
    writeFileSync(path, JSON.stringify(before));
    const driver = adapter([]);
    const ref = { adapter: driver.id, id: 'local_a1' };
    expect(await driver.archive!(ref, () => null)).toEqual({ ok: true, value: { archived: true } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...before, isArchived: true });
    expect(await driver.archive!(ref, () => null)).toEqual({
      ok: true,
      value: { archived: false },
    });
    expect(
      (await driver.find({ includeClosed: false, limit: 20 }))
        .flatMap((group) => group.work)
        .map((work) => work.ref.id)
    ).not.toContain(ref.id);
  });

  test.each(['busy', 'waiting', 'unknown'])(
    'refuses a %s Claude turn without touching its record',
    async (status) => {
      const path = join(dir, 'acct-a/scope-1/local_a1.json');
      const before = readFileSync(path, 'utf8');
      expect(
        await adapter([{ sessionId: 'cli-a1', status }]).archive!(
          { adapter: 'claude-desktop', id: 'local_a1' },
          () => null
        )
      ).toMatchObject({ ok: false, reason: 'busy' });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  );

  test('failed live reads and late admission refusal leave the record unchanged', async () => {
    const ref = { adapter: 'claude-desktop', id: 'local_a1' };
    const path = join(dir, 'acct-a/scope-1/local_a1.json');
    const before = readFileSync(path, 'utf8');
    await expect(adapter(new Error('offline')).archive!(ref, () => null)).rejects.toThrow(
      'offline'
    );
    expect(
      await adapter([]).archive!(ref, () => ({
        ok: false,
        reason: 'live_card',
        detail: 'new card',
      }))
    ).toMatchObject({ ok: false, reason: 'live_card' });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('links a session Remote Control connected to its claude.ai page', async () => {
    const scope = join(dir, 'acct-a/scope-1');
    const write = (id: string, fields: Record<string, unknown>) =>
      writeFileSync(
        join(scope, `local_${id}.json`),
        JSON.stringify(
          record(id, { originCwd: '/focus/remote', title: id, lastActivityAt: 40, ...fields })
        )
      );
    write('r1', {
      remoteControlUserEnabled: true,
      bridgeSessionIds: ['session_01Old', 'session_01UpXXWbbUzh1d3zgVGxQoa5'],
    });
    write('r2', { remoteControlUserEnabled: false, bridgeSessionIds: ['session_01Off'] });
    write('r3', { remoteControlUserEnabled: true, bridgeSessionIds: ['https://evil.example'] });
    write('r4', { bridgeSessionIds: ['session_01Auto'] });
    write('r5', {});
    const status = async (id: string) =>
      (await adapter().status?.({ adapter: 'claude-desktop', id: `local_${id}` })) as {
        value: { link?: string; remoteLink?: string };
      };
    expect((await status('r1')).value).toMatchObject({
      link: 'claude://claude.ai/epitaxy/local_r1',
      remoteLink: 'https://claude.ai/code/session_01UpXXWbbUzh1d3zgVGxQoa5',
    });
    expect((await status('r2')).value.remoteLink).toBeUndefined();
    expect((await status('r3')).value.remoteLink).toBeUndefined();
    expect((await status('r4')).value.remoteLink).toBe('https://claude.ai/code/session_01Auto');
    expect((await status('r5')).value.remoteLink).toBeUndefined();
  });

  test('adds archived sessions as stopped when asked for closed work', async () => {
    const groups = await adapter([]).find({
      includeClosed: true,
      limit: 20,
      folder: '/focus/dolmen',
    });
    expect(groups[0].work.map((w) => [w.title, w.status])).toEqual([
      ['lakehouse loader', 'done'],
      ['old review', 'stopped'],
    ]);
  });

  test('matches sessions by title and projects by name, and has no Spaces', async () => {
    const find = (query: { text?: string; spaceId?: string }) =>
      adapter().find({ includeClosed: false, limit: 20, ...query });
    expect((await find({ text: 'loader' })).map((g) => g.work.map((w) => w.ref.id))).toEqual([
      ['local_a1'],
    ]);
    expect((await find({ text: 'fiso' })).map((g) => g.place.name)).toEqual(['fiso']);
    expect(await find({ spaceId: 'sp1' })).toEqual([]);
  });

  test('reparses only session files that changed since the last search', async () => {
    const cache: ClaudeRecordCache = new Map();
    const first = await readClaudeDesktopRecords(dir, cache);
    const path = join(dir, 'acct-a/scope-1/local_a1.json');
    const reused = cache.get(path);
    const untouched = cache.get(join(dir, 'acct-a/scope-1/local_a2.json'));
    writeFileSync(
      path,
      JSON.stringify(record('a1', { originCwd: '/focus/dolmen', title: 'renamed' }))
    );
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    rmSync(join(dir, 'acct-b/scope-2/local_b2.json'));
    const second = await readClaudeDesktopRecords(dir, cache);
    expect(first.map((r) => r.title).sort()).toEqual([
      'fiso init',
      'lakehouse loader',
      'old review',
      'woodpecker',
    ]);
    expect(second.map((r) => r.title).sort()).toEqual(['fiso init', 'old review', 'renamed']);
    expect(cache.get(path)).not.toBe(reused);
    expect(cache.get(join(dir, 'acct-a/scope-1/local_a2.json'))).toBe(untouched);
    expect(cache.has(join(dir, 'acct-b/scope-2/local_b2.json'))).toBe(false);
  });

  test('does not ask the CLI when every session is archived', async () => {
    let asked = false;
    const archivedOnly = mkdtempSync(join(tmpdir(), 'claude-archived-'));
    mkdirSync(join(archivedOnly, 'a/s'), { recursive: true });
    writeFileSync(
      join(archivedOnly, 'a/s/local_z.json'),
      JSON.stringify(record('z', { originCwd: '/focus/old', isArchived: true }))
    );
    await createClaudeDesktopAdapter({
      sessionsDir: archivedOnly,
      projectsDir: join(archivedOnly, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        asked = true;
        return [];
      },
      spawn: () => {
        throw new Error('not spawned');
      },
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'unused',
      sleep: async () => {},
      now: () => 0,
    }).find({ includeClosed: true, limit: 20 });
    rmSync(archivedOnly, { recursive: true, force: true });
    expect(asked).toBe(false);
  });

  test('status reports live state and the last reply from the transcript', async () => {
    const transcripts = join(dir, 'projects', '-focus-dolmen--claude-worktrees-w1');
    mkdirSync(transcripts, { recursive: true });
    const turn = (type: string, text: string) =>
      JSON.stringify({ type, message: { role: type, content: [{ type: 'text', text }] } });
    writeFileSync(
      join(transcripts, 'cli-a1.jsonl'),
      [turn('user', 'load it'), turn('assistant', 'Loaded 3 tables.'), '{"type":"pr-link"}'].join(
        '\n'
      )
    );
    expect(await adapter().status?.({ adapter: 'claude-desktop', id: 'local_a1' })).toEqual({
      ok: true,
      value: {
        ref: { adapter: 'claude-desktop', id: 'local_a1' },
        title: 'lakehouse loader',
        place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' },
        status: 'needs_you',
        lastActivityAt: 30,
        link: 'claude://claude.ai/epitaxy/local_a1',
        execution: { directory: '/focus/dolmen/.claude/worktrees/w1', machine: 'laptop' },
        lastReply: 'Loaded 3 tables.',
        recentInputs: [],
      },
    });
    expect(await adapter().status?.({ adapter: 'claude-desktop', id: 'local_b2' })).toMatchObject({
      ok: true,
      value: { title: 'woodpecker', status: 'done' },
    });
    expect(await adapter().status?.({ adapter: 'claude-desktop', id: 'local_zz' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  test('status times the latest message to the session and its last activity from the transcript', async () => {
    const transcripts = join(dir, 'projects', '-focus-dolmen--claude-worktrees-w1');
    mkdirSync(transcripts, { recursive: true });
    const entry = (timestamp: string, fields: Record<string, unknown>) =>
      JSON.stringify({ timestamp, ...fields });
    writeFileSync(
      join(transcripts, 'cli-a1.jsonl'),
      [
        entry('2026-10-08T11:50:50.394Z', {
          type: 'user',
          isMeta: true,
          origin: { kind: 'peer', body: 'Load the  orders.\nNeo routed this to you.' },
          message: { content: '<cross-session-message>Load the orders.</cross-session-message>' },
        }),
        entry('2026-10-08T11:51:00.000Z', {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done.' }] },
        }),
        entry('2026-10-08T11:52:00.000Z', {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'ok' }] },
        }),
      ].join('\n')
    );
    expect(await adapter().status?.({ adapter: 'claude-desktop', id: 'local_a1' })).toMatchObject({
      ok: true,
      value: {
        recentInputs: [
          {
            at: Date.parse('2026-10-08T11:50:50.394Z'),
            text: 'Load the orders. Neo routed this to you.',
          },
        ],
        lastActivityAt: Date.parse('2026-10-08T11:52:00.000Z'),
        lastReply: 'Done.',
        lastReplyAt: Date.parse('2026-10-08T11:51:00.000Z'),
      },
    });
  });

  test('refuses missing direct transport without spawning a model relay', async () => {
    expect(
      await adapter().send?.({ adapter: 'claude-desktop', id: 'local_a1' }, 'next', user)
    ).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(spawned).toEqual([]);
  });

  test('send refuses to resume when it cannot tell what the app runs, while find carries on', async () => {
    const blind = adapter(new Error('timed out'));
    expect(await blind.send?.({ adapter: 'claude-desktop', id: 'local_b2' }, 'next', user)).toEqual(
      {
        ok: false,
        reason: 'not_delivered',
        detail: 'Could not inspect live Claude sessions: timed out',
      }
    );
    expect(spawned).toEqual([]);
    const groups = await blind.find({ includeClosed: false, limit: 20 });
    expect(groups.flatMap((group) => group.work.map((work) => work.status))).not.toContain(
      'needs_you'
    );
    expect(groups.length).toBeGreaterThan(0);
  });

  test('send asks the CLI afresh which sessions the app is running', async () => {
    const reader = adapter([]);
    await reader.find({ includeClosed: false, limit: 20 });
    const before = liveReads;
    await reader.send?.({ adapter: 'claude-desktop', id: 'local_b2' }, 'next', user);
    expect(liveReads).toBe(before + 1);
  });

  test('send never resumes absent owners and still refuses archived sessions', async () => {
    const ref = { adapter: 'claude-desktop', id: 'local_b2' };
    expect(await adapter([]).send?.(ref, '-v next', user)).toMatchObject({
      ok: false,
      reason: 'unreachable',
      detail: expect.stringContaining('will not resume'),
    });
    expect(spawned).toEqual([]);
    expect(
      await adapter([]).send?.({ adapter: 'claude-desktop', id: 'local_a2' }, 'next', user)
    ).toMatchObject({ ok: false, reason: 'not_open' });
    expect(spawned).toEqual([]);
  });

  test.each(['desktop', 'unknown', undefined] as const)(
    'send does not relay or resume a live %s owner',
    async (owner) => {
      const driver = adapter([
        { sessionId: 'cli-a1', status: 'busy', name: 'lakehouse loader', pid: 1, owner },
      ]);
      expect(
        await driver.send?.({ adapter: 'claude-desktop', id: 'local_a1' }, 'next', user)
      ).toMatchObject({
        ok: false,
        reason: owner === 'desktop' ? 'unsupported' : 'unreachable',
      });
      expect(spawned).toEqual([]);
    }
  );

  test('status reads the exchange that answered a receipt, and only its own reply', async () => {
    const transcripts = join(dir, 'projects', '-focus-dolmen--claude-worktrees-w1');
    mkdirSync(transcripts, { recursive: true });
    const at = (second: number) => `2026-10-14T10:00:0${second}.000Z`;
    const said = (uuid: string, text: string, second: number, stop = 'end_turn') =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        timestamp: at(second),
        message: { content: [{ type: 'text', text }], stop_reason: stop },
      });
    writeFileSync(
      join(transcripts, 'cli-a1.jsonl'),
      `${[
        JSON.stringify({
          type: 'user',
          uuid: 'u0',
          timestamp: at(0),
          message: { content: 'earlier' },
        }),
        said('a0', 'earlier reply', 1),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: at(2),
          message: { content: 'load orders' },
        }),
        said('a1', 'loading', 3, 'tool_use'),
        said('a2', 'loaded 12 orders', 4),
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          timestamp: at(5),
          message: { content: 'any news?' },
        }),
        said('a3', 'nothing new', 6),
      ].join('\n')}\n`
    );
    const ref = { adapter: 'claude-desktop', id: 'local_a1' };
    const status = await adapter().status?.(ref, undefined, {
      executionId: 'cli-a1',
      inputId: 'u1',
    });
    expect(status).toMatchObject({
      ok: true,
      value: {
        inputEvidence: {
          state: 'observed',
          exchangeCut: false,
          exchange: [
            { role: 'user', text: 'load orders' },
            { role: 'agent', text: 'loading' },
            { role: 'agent', text: 'loaded 12 orders' },
          ],
        },
      },
    });
    expect(WorkDetailSchema.safeParse(status?.ok ? status.value : null).success).toBe(true);
    for (const receipt of [
      { executionId: 'cli-other', inputId: 'u1' },
      { executionId: 'cli-a1', inputId: 'missing' },
    ])
      expect(await adapter().status?.(ref, undefined, receipt)).toMatchObject({
        ok: true,
        value: { inputEvidence: { receipt, state: 'unavailable' } },
      });
    const plain = await adapter().status?.(ref);
    expect(plain?.ok && 'inputEvidence' in plain.value).toBe(false);
  });

  test('answers a Space search without reading records or asking the CLI', async () => {
    let asked = false;
    const groups = await createClaudeDesktopAdapter({
      sessionsDir: join(dir, 'missing'),
      projectsDir: join(dir, 'missing'),
      machine: 'laptop',
      liveSessions: async () => {
        asked = true;
        return [];
      },
      spawn: () => {
        throw new Error('not spawned');
      },
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'unused',
      sleep: async () => {},
      now: () => 0,
    }).find({ includeClosed: false, limit: 20, spaceId: 'sp1' });
    expect(groups).toEqual([]);
    expect(asked).toBe(false);
  });
});

describe('readLiveClaudeSessions', () => {
  function spawnWith(stdout: string, code = 0): SpawnFn {
    return () => ({
      stdout: new Response(stdout).body,
      stderr: null,
      exited: Promise.resolve(code),
      exitCode: code,
      kill: () => {},
    });
  }

  test('reads the live sessions claude agents reports', async () => {
    expect(
      await readLiveClaudeSessions(
        spawnWith('[{"pid":1,"sessionId":"cli-a1","status":"busy","name":"x"}]'),
        '/missing-claude-registrations'
      )
    ).toEqual([{ pid: 1, sessionId: 'cli-a1', status: 'busy', name: 'x', owner: 'unknown' }]);
  });

  test('skips entries without a session or status instead of failing the whole list', async () => {
    expect(
      await readLiveClaudeSessions(
        spawnWith(
          JSON.stringify([
            { pid: 1, kind: 'interactive', sessionId: 'cli-a1', name: null, status: 'idle' },
            { pid: 2, kind: 'interactive', sessionId: 'cli-starting' },
            { pid: 3, kind: 'bg', jobId: 'job-1', status: 'busy' },
            {
              pid: 4,
              kind: 'interactive',
              sessionId: 'cli-b2',
              name: 'Neo iOS app',
              status: 'busy',
            },
          ])
        ),
        '/missing-claude-registrations'
      )
    ).toEqual([
      { pid: 1, sessionId: 'cli-a1', status: 'idle', name: undefined, owner: 'unknown' },
      { pid: 4, sessionId: 'cli-b2', status: 'busy', name: 'Neo iOS app', owner: 'unknown' },
    ]);
  });

  test('fails when the CLI is missing or its output is unreadable', async () => {
    await expect(readLiveClaudeSessions(spawnWith('[]', 1))).rejects.toThrow('exited with 1');
    await expect(readLiveClaudeSessions(spawnWith('Usage: claude'))).rejects.toThrow();
    await expect(readLiveClaudeSessions(spawnWith('{"sessions":[]}'))).rejects.toThrow(
      'unknown shape'
    );
    await expect(
      readLiveClaudeSessions(() => {
        throw new Error('ENOENT');
      })
    ).rejects.toThrow('ENOENT');
  });
});

describe('reuseLiveSessions', () => {
  test('asks the CLI again only after the reuse window', async () => {
    let reads = 0;
    let clock = 0;
    const live = reuseLiveSessions(
      async () => {
        reads++;
        return [];
      },
      () => clock,
      1_000
    );
    await live();
    clock = 999;
    await live();
    expect(reads).toBe(1);
    clock = 1_000;
    await live();
    expect(reads).toBe(2);
  });
});

describe('claudeTranscriptState', () => {
  test('counts typed, relayed and notified messages as input, not tool results or bare notes', () => {
    const user = (timestamp: string, fields: Record<string, unknown>) =>
      JSON.stringify({ type: 'user', timestamp, ...fields });
    const state = claudeTranscriptState([
      user('2026-10-08T10:00:00.000Z', { message: { content: 'typed' } }),
      user('2026-10-08T10:01:00.000Z', {
        isMeta: true,
        turnOrigin: 'system',
        message: { content: 'notice' },
      }),
      user('2026-10-08T10:02:00.000Z', {
        message: { content: [{ type: 'tool_result', content: 'x' }] },
      }),
      user('2026-10-08T10:03:00.000Z', { isMeta: true, message: { content: 'cut off' } }),
      '{"type":"pr-link"}',
      'not json',
    ]);
    expect(state).toEqual({
      reply: null,
      inputs: [
        { at: Date.parse('2026-10-08T10:00:00.000Z'), text: 'typed', human: true },
        { at: Date.parse('2026-10-08T10:01:00.000Z'), text: 'notice', human: false },
      ],
      lastAt: Date.parse('2026-10-08T10:03:00.000Z'),
    });
  });

  test('counts a peer message queued while the session was busy as input', () => {
    const queued = (timestamp: string, origin: Record<string, unknown>) =>
      JSON.stringify({
        type: 'attachment',
        timestamp,
        attachment: {
          type: 'queued_command',
          prompt:
            '<cross-session-message from="uds:/tmp/cc-socks/55057.sock">…</cross-session-message>',
          commandMode: 'prompt',
          origin,
          timestamp,
          isMeta: true,
        },
      });
    const state = claudeTranscriptState([
      queued('2026-10-09T01:31:08.369Z', {
        kind: 'peer',
        from: 'uds:/tmp/cc-socks/55057.sock',
        name: 'HyperNeo relay',
        body: 'Scope addition from the user: a pushed branch alone does not count as finished.',
      }),
      queued('2026-10-09T01:32:00.000Z', { kind: 'human' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'x' } }),
    ]);
    expect(state.inputs).toEqual([
      {
        at: Date.parse('2026-10-09T01:31:08.369Z'),
        text: 'Scope addition from the user: a pushed branch alone does not count as finished.',
        human: false,
      },
    ]);
  });

  test('lists the messages after since, typed, relayed and said', () => {
    const entry = (timestamp: string, fields: Record<string, unknown>) =>
      JSON.stringify({ timestamp, ...fields });
    const lines = [
      entry('2026-10-08T10:00:00.000Z', {
        type: 'user',
        isMeta: true,
        origin: { kind: 'peer', body: 'Neo asks: load it' },
        message: { content: 'wrapped' },
      }),
      entry('2026-10-08T10:01:00.000Z', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Loading.' }] },
      }),
      entry('2026-10-08T10:02:00.000Z', {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      }),
      entry('2026-10-08T10:03:00.000Z', { type: 'user', message: { content: 'and the rest' } }),
      entry('2026-10-08T10:04:00.000Z', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'All loaded.' }] },
      }),
    ];
    expect(claudeTranscriptState(lines, Date.parse('2026-10-08T10:00:00.000Z')).exchange).toEqual({
      entries: [
        { at: Date.parse('2026-10-08T10:01:00.000Z'), role: 'agent', text: 'Loading.' },
        { at: Date.parse('2026-10-08T10:03:00.000Z'), role: 'user', text: 'and the rest' },
        { at: Date.parse('2026-10-08T10:04:00.000Z'), role: 'agent', text: 'All loaded.' },
      ],
      cut: false,
    });
    expect(claudeTranscriptState(lines).exchange).toBeUndefined();
  });
});

describe('claudeInputEvidence', () => {
  const receipt = { executionId: 'cli-a1', inputId: 'u1' };
  const input = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-10-14T10:00:00.000Z',
    message: { content: 'go' },
  });
  const reply = (n: number, stop: string | null = 'end_turn') =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.parse('2026-10-14T10:00:01.000Z') + n).toISOString(),
      message: { content: [{ type: 'text', text: `step ${n}` }], stop_reason: stop },
    });

  test('is pending until the turn ends, and a half-written last line is still being written', () => {
    expect(claudeInputEvidence([input], receipt, 'cli-a1')).toEqual({ receipt, state: 'pending' });
    expect(claudeInputEvidence([input, reply(0, 'tool_use')], receipt, 'cli-a1')).toEqual({
      receipt,
      state: 'pending',
    });
    expect(
      claudeInputEvidence(
        [input, reply(0, 'tool_use'), reply(1), '{"type":"assist'],
        receipt,
        'cli-a1'
      )
    ).toMatchObject({
      state: 'observed',
      exchange: [{ text: 'go' }, { text: 'step 0' }, { text: 'step 1' }],
    });
  });

  test('cuts the exchange at forty entries and says so', () => {
    const evidence = claudeInputEvidence(
      [input, ...Array.from({ length: 45 }, (_, n) => reply(n))],
      receipt,
      'cli-a1'
    );
    expect(evidence).toMatchObject({ state: 'observed', exchangeCut: true });
    expect(evidence.state === 'observed' && evidence.exchange).toHaveLength(40);
  });

  test("skips a subagent's sidechain entries instead of ending the turn on them", () => {
    const sidechain = (type: 'user' | 'assistant', text: string) =>
      JSON.stringify({
        type,
        isSidechain: true,
        timestamp: '2026-10-14T10:00:01.500Z',
        message: { content: type === 'user' ? text : [{ type: 'text', text }] },
      });
    expect(
      claudeInputEvidence(
        [
          input,
          reply(0),
          sidechain('user', 'search the repo'),
          sidechain('assistant', 'found it'),
          reply(900),
        ],
        receipt,
        'cli-a1'
      )
    ).toMatchObject({
      state: 'observed',
      exchange: [
        { role: 'user', text: 'go' },
        { role: 'agent', text: 'step 0' },
        { role: 'agent', text: 'step 900' },
      ],
    });
  });

  test('a peer message queued while the turn runs does not end it', () => {
    const queued = JSON.stringify({
      type: 'attachment',
      timestamp: '2026-10-14T10:00:01.500Z',
      attachment: { type: 'queued_command', origin: { kind: 'peer', body: 'another card' } },
    });
    expect(claudeInputEvidence([input, reply(0, 'tool_use'), queued], receipt, 'cli-a1')).toEqual({
      receipt,
      state: 'pending',
    });
    expect(
      claudeInputEvidence([input, reply(0, 'tool_use'), queued, reply(900)], receipt, 'cli-a1')
    ).toMatchObject({
      state: 'observed',
      exchange: [{ text: 'go' }, { text: 'step 0' }, { text: 'step 900' }],
    });
  });

  test('is unavailable when a line in its window is malformed', () => {
    expect(claudeInputEvidence([input, '{broken', reply(1)], receipt, 'cli-a1')).toEqual({
      receipt,
      state: 'unavailable',
    });
  });
});
