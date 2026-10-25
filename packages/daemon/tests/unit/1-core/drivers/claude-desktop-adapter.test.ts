import { requireClaudeReplyDestination } from '../../../../src/lib/drivers/claude-inbox-submit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaudeDesktopAdapterDeps,
  type ClaudeRecordCache,
  type ClaudeLiveSession,
  relayNativeDesktopMessage,
  readClaudeInputEvidence,
  claudeDirectInput,
  claudeNativeInput,
  claudeInputEvidence,
  claudeTranscriptState,
  createClaudeDesktopAdapter,
  readClaudeDesktopRecords,
  readLiveClaudeSessions,
  reuseLiveSessions,
} from '../../../../src/lib/drivers/claude-desktop-adapter';
import { WorkDeliverySchema, WorkDetailSchema } from '../../../../src/lib/drivers/types';
import { claudeInboxText } from '../../../../src/lib/drivers/claude-inbox';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';

describe('claudeDirectInput', () => {
  test.each([
    ['a split emoji at the cut', `${'x'.repeat(199)}😀 and more\nsecond line`],
    ['a quoted inbox tag', 'Quote <cross-session-message from="a"> back to me'],
  ])('finds the queued copy of a message with %s', (_, message) => {
    const queued = JSON.stringify({
      type: 'queue-operation',
      content: `<cross-session-message from="uds:/x.sock">\n${claudeInboxText(message)}\n</cross-session-message>`,
    });
    expect(claudeDirectInput([queued], 'in-1', message)).toEqual({
      inputId: 'in-1',
      at: undefined,
    });
    expect(claudeDirectInput([queued], 'in-1', 'something else')).toBeUndefined();
  });
});

function record(id: string, fields: Record<string, unknown>) {
  return { sessionId: `local_${id}`, cliSessionId: `cli-${id}`, ...fields };
}

const user = { from: 'user', caller: { source: 'rpc' as const } };
const desktopUI = {
  state: 'ui-unconfirmed',
  detail: expect.stringContaining('No supported live Desktop render/read acknowledgment'),
};

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
  let clock = 0;

  function adapter(
    live: ClaudeLiveSession[] | Error | (() => ClaudeLiveSession[]) = [
      {
        sessionId: 'cli-a1',
        status: 'waiting',
        name: 'lakehouse loader',
        owner: 'cli',
        pid: 1,
        waitingFor: 'permission prompt',
      },
    ],
    exitCode = 0,
    onSpawn = () => {},
    output: { stdout?: string; stderr?: string } = { stderr: exitCode ? 'relay failed' : '' },
    sendInbox?: ClaudeDesktopAdapterDeps['sendInbox']
  ) {
    spawned = [];
    clock = 0;
    return createClaudeDesktopAdapter({
      sendInbox,
      admitInbox: sendInbox
        ? (context) => requireClaudeReplyDestination(context, { hasSession: () => false })
        : undefined,
      listProcesses: async () => [],
      sessionsDir: dir,
      projectsDir: join(dir, 'projects'),
      machine: 'laptop',
      liveSessions: async () => {
        liveReads++;
        if (live instanceof Error) throw live;
        return typeof live === 'function' ? live() : live;
      },
      folderExists: (folder) => folder !== '/gone',
      makeFolder: () => {},
      homeDir: '/Users/test',
      gitCheckout: async () => null,
      newId: () => 'unused',
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
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

  test.each([false, true])(
    'an import between CLI turns leaves Desktop UI unconfirmed (second turn completed: %s)',
    async (completed) => {
      const folder = join(dir, 'projects', '-focus-ops');
      mkdirSync(folder, { recursive: true });
      const transcript = join(folder, 'cli-b2.jsonl');
      const entry = (type: string, uuid: string, text: string) =>
        JSON.stringify({
          type,
          uuid,
          timestamp: '2026-10-21T20:00:00.000Z',
          ...(type === 'user'
            ? { entrypoint: 'sdk-cli', permissionMode: 'bypassPermissions' }
            : {}),
          message: {
            content: type === 'user' ? text : [{ type: 'text', text }],
            ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}),
          },
        }) + '\n';
      writeFileSync(
        transcript,
        entry('user', 'first-input', 'First turn') + entry('assistant', 'first-reply', 'Turn one')
      );
      const importedPath = join(dir, 'acct-b/scope-2/local_b2.json');
      writeFileSync(
        importedPath,
        JSON.stringify(record('b2', { cwd: '/focus/ops', permissionMode: 'acceptEdits' }))
      );
      const imported = readFileSync(importedPath, 'utf8');
      const renderedPath = join(dir, 'synthetic-rendered.json');
      writeFileSync(renderedPath, JSON.stringify(['Turn one']));
      const driver = adapter([], 0, () => {
        appendFileSync(transcript, entry('user', 'second-input', 'Second turn'));
        if (completed) appendFileSync(transcript, entry('assistant', 'second-reply', 'Turn two'));
      });
      const ref = { adapter: 'claude-desktop', id: 'local_b2' };
      const sent = await driver.send!(ref, 'Second turn', user);
      expect(sent.ok).toBe(true);
      if (!sent.ok) throw new Error(sent.detail);
      const receipt = sent.value.receipt!;
      const status = await driver.status!(ref, undefined, receipt);
      const resumeCommands = [...spawned];
      const restarted = await adapter([]).status!(ref, undefined, receipt);
      expect(readFileSync(importedPath, 'utf8')).toBe(imported);
      expect(JSON.parse(readFileSync(renderedPath, 'utf8'))).toEqual(['Turn one']);
      expect(readFileSync(transcript, 'utf8').match(/end_turn/g)).toHaveLength(completed ? 2 : 1);
      expect(resumeCommands.map((command) => command.args.slice(0, 4))).toEqual([
        ['claude', '-p', '--resume', 'cli-b2'],
      ]);
      expect(spawned).toEqual([]);
      expect(sent.value.delivered).toBe(true);
      expect(receipt).toEqual({ executionId: 'cli-b2', inputId: 'second-input' });
      expect(WorkDeliverySchema.parse(sent.value)).toMatchObject({
        desktopUI: { state: 'ui-unconfirmed' },
      });
      for (const result of [status, restarted]) {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.detail);
        expect(WorkDetailSchema.parse(result.value)).toMatchObject({
          desktopUI: { state: 'ui-unconfirmed' },
          inputEvidence: {
            receipt,
            transcriptState: completed ? 'completed' : 'accepted',
            state: completed ? 'observed' : 'pending',
          },
        });
        if (completed)
          expect(result.value.inputEvidence).toMatchObject({
            exchange: [{ text: 'Second turn' }, { text: 'Turn two' }],
          });
      }
    }
  );

  describe('send confirms delivery in the target transcript', () => {
    const ref = { adapter: 'claude-desktop', id: 'local_a1' };
    const context = { from: 'session:origin', caller: { source: 'internal' as const } };
    const written = {
      ok: true as const,
      value: {
        delivered: false,
        unconfirmed: true as const,
        receipt: { executionId: 'cli-a1', inputId: 'in-1' },
      },
    };
    const refused = { ok: false as const, reason: 'unreachable' as const, detail: 'no inbox' };
    let transcript: string;
    beforeEach(() => {
      const folder = join(dir, 'projects', '-focus-dolmen--claude-worktrees-w1');
      mkdirSync(folder, { recursive: true });
      transcript = join(folder, 'cli-a1.jsonl');
      writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'older' })}\n`);
    });
    const append = (entry: Record<string, unknown>) =>
      appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
    const at = '2026-10-17T21:18:25.000Z';
    const confirmedAt = Date.parse(at);
    const relayed = (uuid?: string) => ({
      type: uuid ? 'user' : 'queue-operation',
      timestamp: at,
      ...(uuid ? { uuid } : {}),
      content: '<cross-session-message from="x">\nload "orders"\n</cross-session-message>',
    });

    test.each([
      ['its own input', { type: 'user', uuid: 'in-1', timestamp: at }],
      [
        'a queued copy of it',
        { type: 'queue-operation', timestamp: at, content: 'load \"orders\" then stop' },
      ],
    ])('the direct message counts once the transcript shows %s', async (_, entry) => {
      const driver = adapter(undefined, 0, undefined, undefined, async () => {
        append(entry);
        return written;
      });
      expect(await driver.send?.(ref, 'load "orders" then stop', context)).toEqual({
        ok: true,
        value: {
          delivered: true,
          receipt: { executionId: 'cli-a1', inputId: 'in-1' },
          confirmedAt,
          desktopUI,
          remoteControl: false,
        },
      });
      expect(spawned).toEqual([]);
    });

    test('a direct message held past the confirmation window stays pending under its receipt, with no relay, until a later status read confirms it', async () => {
      const held = adapter(undefined, 0, undefined, undefined, async () => written);
      expect(await held.send?.(ref, 'load "orders" then stop', context)).toEqual({
        ok: true,
        value: { ...written.value, desktopUI, remoteControl: false },
      });
      expect(spawned).toEqual([]);
      const receipt = written.value.receipt;
      expect(await held.status?.(ref, undefined, receipt)).toMatchObject({
        ok: true,
        value: { inputEvidence: { receipt, state: 'unavailable' } },
      });
      append({
        type: 'user',
        uuid: 'in-1',
        timestamp: at,
        message: { content: 'load "orders" then stop' },
      });
      append({
        type: 'assistant',
        uuid: 'out-1',
        timestamp: at,
        message: { content: [{ type: 'text', text: 'loaded' }], stop_reason: 'end_turn' },
      });
      expect(await held.status?.(ref, undefined, receipt)).toMatchObject({
        ok: true,
        value: { inputEvidence: { receipt, state: 'observed', transcriptState: 'completed' } },
      });
      expect(spawned).toEqual([]);
    });

    test('a refused direct message falls back to the relay', async () => {
      const relay = adapter(
        undefined,
        0,
        () => append(relayed('u-relay')),
        undefined,
        async () => refused
      );
      expect(await relay.send?.(ref, 'load "orders"\nthen stop', context)).toEqual({
        ok: true,
        value: {
          delivered: true,
          receipt: { executionId: 'cli-a1', inputId: 'u-relay' },
          confirmedAt,
          desktopUI,
          remoteControl: false,
        },
      });
      expect(spawned[0].args.slice(0, 13)).toEqual([
        'claude',
        '-p',
        '--model',
        'haiku',
        '--max-turns',
        '4',
        '--permission-mode',
        'default',
        '--tools',
        'SendMessage ListAgents',
        '--allowedTools',
        'SendMessage ListAgents',
        '-n',
      ]);
      expect(spawned[0].args.at(-1)).toContain('session named "lakehouse loader"');
      const queued = adapter(
        undefined,
        0,
        () => append(relayed()),
        undefined,
        async () => refused
      );
      expect(await queued.send?.(ref, 'load "orders"\nthen stop', context)).toEqual({
        ok: true,
        value: { delivered: true, confirmedAt, desktopUI, remoteControl: false },
      });
      const lost = adapter(undefined, 1, undefined, undefined, async () => refused);
      expect(await lost.send?.(ref, 'load "orders"', context)).toEqual({
        ok: false,
        reason: 'not_delivered',
        detail: expect.stringContaining('the direct inbox message failed (no inbox)'),
      });
      expect(await lost.send?.(ref, 'load "orders"', context)).toMatchObject({
        detail: expect.stringContaining('the relay failed: relay failed'),
      });
    });

    test('finds the transcript of a session whose record names no folder', async () => {
      writeFileSync(
        join(dir, 'acct-a/scope-1/local_c1.json'),
        JSON.stringify(record('c1', { title: 'Quick chat' }))
      );
      const folder = join(dir, 'projects', '-somewhere-else');
      mkdirSync(folder, { recursive: true });
      const chat = join(folder, 'cli-c1.jsonl');
      writeFileSync(chat, `${JSON.stringify({ type: 'user', uuid: 'older' })}\n`);
      const live: ClaudeLiveSession[] = [
        { sessionId: 'cli-c1', status: 'idle', name: 'Quick chat', owner: 'cli', pid: 1 },
      ];
      const driver = adapter(live, 0, undefined, undefined, async () => {
        appendFileSync(chat, `${JSON.stringify({ type: 'user', uuid: 'in-c1' })}\n`);
        return {
          ok: true,
          value: {
            delivered: false,
            unconfirmed: true,
            receipt: { executionId: 'cli-c1', inputId: 'in-c1' },
          },
        };
      });
      expect(
        await driver.send?.({ adapter: 'claude-desktop', id: 'local_c1' }, 'hi', context)
      ).toEqual({
        ok: true,
        value: {
          delivered: true,
          receipt: { executionId: 'cli-c1', inputId: 'in-c1' },
          confirmedAt: 0,
          desktopUI,
          remoteControl: false,
        },
      });
      expect(spawned).toEqual([]);
    });

    test('a relay that never shows up and an expired CLI login are reported as such', async () => {
      const silent = adapter(undefined, 0, undefined, undefined, async () => refused);
      expect(await silent.send?.(ref, 'load "orders"', context)).toMatchObject({
        reason: 'not_delivered',
        detail: expect.stringContaining('the relayed message did not appear either'),
      });
      const expired = adapter(
        undefined,
        1,
        undefined,
        { stdout: 'Failed to authenticate: OAuth session expired', stderr: '' },
        async () => refused
      );
      expect(await expired.send?.(ref, 'load "orders"', context)).toMatchObject({
        reason: 'claude_cli_login_expired',
      });
    });

    test('the relay runs in the permission mode of a session that bypasses permissions', async () => {
      writeFileSync(
        join(dir, 'acct-a/scope-1/local_p1.json'),
        JSON.stringify(
          record('p1', {
            cwd: '/focus/ios',
            title: 'Neo iOS app',
            permissionMode: 'bypassPermissions',
          })
        )
      );
      const live: ClaudeLiveSession[] = [
        { sessionId: 'cli-p1', status: 'idle', name: 'Neo iOS app', owner: 'cli', pid: 1 },
      ];
      await adapter(live, 1, undefined, undefined, async () => refused).send?.(
        { adapter: 'claude-desktop', id: 'local_p1' },
        'next',
        context
      );
      expect(spawned[0].args.slice(4, 8)).toEqual([
        '--max-turns',
        '4',
        '--permission-mode',
        'bypassPermissions',
      ]);
    });
  });

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
      desktopUI,
      remoteControl: false,
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
        reason: 'busy',
        detail: 'new card',
      }))
    ).toMatchObject({ ok: false, reason: 'busy' });
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

  test('reports the pull requests Claude Desktop linked to the session, with dismissals', async () => {
    const scope = join(dir, 'acct-a/scope-1');
    const pr = (n: number, dismissed?: boolean) => ({
      prNumber: n,
      repo: 'lsm/open-agent-protocol',
      url: `https://github.com/lsm/open-agent-protocol/pull/${n}`,
      state: 'OPEN',
      ...(dismissed === undefined ? {} : { dismissed }),
    });
    writeFileSync(
      join(scope, 'local_p1.json'),
      JSON.stringify(
        record('p1', {
          originCwd: '/focus/oap',
          title: 'OAP TUI',
          lastActivityAt: 40,
          prs: [pr(1064, true), pr(1299, false), pr(1305)],
        })
      )
    );
    writeFileSync(
      join(scope, 'local_p2.json'),
      JSON.stringify(record('p2', { originCwd: '/focus/oap', title: 'none', lastActivityAt: 40 }))
    );
    const status = async (id: string) =>
      (await adapter().status?.({ adapter: 'claude-desktop', id: `local_${id}` })) as {
        value: { linkedPrs?: unknown };
      };
    expect((await status('p1')).value.linkedPrs).toEqual([
      { url: 'https://github.com/lsm/open-agent-protocol/pull/1064', dismissed: true },
      { url: 'https://github.com/lsm/open-agent-protocol/pull/1299' },
      { url: 'https://github.com/lsm/open-agent-protocol/pull/1305' },
    ]);
    expect((await status('p2')).value.linkedPrs).toBeUndefined();
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

  test('explicit status observes a new permission wait without reusing the previous idle state', async () => {
    let pending = false;
    const driver = adapter(() => [
      {
        sessionId: 'cli-a1',
        pid: 1,
        owner: 'desktop',
        status: pending ? 'waiting' : 'idle',
        ...(pending ? { waitingFor: 'permission prompt' } : {}),
      },
    ]);
    const ref = { adapter: 'claude-desktop', id: 'local_a1' };
    expect(await driver.status!(ref)).toMatchObject({ ok: true, value: { status: 'done' } });
    pending = true;
    expect(await driver.status!(ref)).toMatchObject({
      ok: true,
      value: { status: 'needs_you', waitingFor: 'permission prompt' },
    });
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
        desktopUI,
        remoteControl: false,
        execution: { directory: '/focus/dolmen/.claude/worktrees/w1', machine: 'laptop' },
        waitingFor: 'permission prompt',
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
    const reader = adapter([
      { sessionId: 'cli-b2', status: 'idle', name: 'woodpecker', owner: 'cli', pid: 2 },
    ]);
    await reader.find({ includeClosed: false, limit: 20 });
    const before = liveReads;
    await reader.send?.({ adapter: 'claude-desktop', id: 'local_b2' }, 'next', user);
    expect(liveReads).toBe(before + 1);
  });

  describe('send to a session that is not running', () => {
    const ref = { adapter: 'claude-desktop', id: 'local_b2' };
    let transcript: string;
    beforeEach(() => {
      const folder = join(dir, 'projects', '-focus-ops');
      mkdirSync(folder, { recursive: true });
      transcript = join(folder, 'cli-b2.jsonl');
      writeFileSync(
        join(dir, 'acct-b', 'scope-2', 'local_b2.json'),
        JSON.stringify(
          record('b2', {
            cwd: '/focus/ops',
            title: 'woodpecker',
            lastActivityAt: 5,
            permissionMode: 'auto',
          })
        )
      );
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: 'user', uuid: 'older', message: { content: 'run the audit' } })}\n`
      );
    });

    const context = { from: 'session:origin', caller: { source: 'internal' as const } };
    const resumeAs = (mode: string, firstTurn?: { entrypoint: string; permissionMode: string }) => {
      writeFileSync(
        join(dir, 'acct-b', 'scope-2', 'local_b2.json'),
        JSON.stringify(
          record('b2', {
            cwd: '/focus/ops',
            title: 'woodpecker',
            lastActivityAt: 5,
            permissionMode: mode,
          })
        )
      );
      if (firstTurn)
        writeFileSync(
          transcript,
          `${JSON.stringify({ type: 'user', uuid: 'first', ...firstTurn, message: { content: 'the task' } })}\n${JSON.stringify({ type: 'user', uuid: 'older', message: { content: 'run the audit' } })}\n`
        );
      return adapter([], 0, () =>
        appendFileSync(
          transcript,
          `${JSON.stringify({ type: 'user', uuid: 'in-b2', timestamp: '2026-10-18T01:00:00.000Z', message: { content: 'run the audit' } })}\n`
        )
      );
    };
    const resumed = (mode: string) => [
      {
        args: [
          'claude',
          '-p',
          '--resume',
          'cli-b2',
          '--permission-mode',
          mode,
          '--',
          'run the audit',
        ],
        cwd: '/focus/ops',
      },
    ];
    const delivered = {
      ok: true,
      value: {
        delivered: true,
        receipt: { executionId: 'cli-b2', inputId: 'in-b2' },
        confirmedAt: Date.parse('2026-10-18T01:00:00.000Z'),
        desktopUI,
        remoteControl: false,
      },
    };

    test('runs the message as a CLI turn on the session, in its own mode, and confirms it', async () => {
      expect(await resumeAs('auto').send?.(ref, 'run the audit', context)).toEqual(delivered);
      expect(spawned).toEqual(resumed('auto'));
    });

    test('a stopped Desktop session uses auto instead of its historical bypass mode', async () => {
      const driver = resumeAs('acceptEdits', {
        entrypoint: 'sdk-cli',
        permissionMode: 'bypassPermissions',
      });
      expect(await driver.send?.(ref, 'run the audit', context)).toEqual(delivered);
      expect(spawned).toEqual(resumed('auto'));
    });

    test.each([
      ['acceptEdits', { entrypoint: 'claude-desktop', permissionMode: 'acceptEdits' }],
      ['default', undefined],
      ['acceptEdits', { entrypoint: 'sdk-cli', permissionMode: 'acceptEdits' }],
    ] as const)(
      'a stopped Desktop session recorded as %s uses the authorized auto headless route',
      async (mode, firstTurn) => {
        expect(await resumeAs(mode, firstTurn).send?.(ref, 'run the audit', context)).toEqual(
          delivered
        );
        expect(spawned).toEqual(resumed('auto'));
      }
    );

    test('says plainly when the session folder is gone, without running anything', async () => {
      writeFileSync(
        join(dir, 'acct-b', 'scope-2', 'local_b2.json'),
        JSON.stringify(
          record('b2', {
            cwd: '/gone',
            title: 'woodpecker',
            lastActivityAt: 5,
            permissionMode: 'auto',
          })
        )
      );
      expect(await adapter([]).send?.(ref, 'run the audit', context)).toEqual({
        ok: false,
        reason: 'unreachable',
        detail:
          'woodpecker is not open in Claude Desktop, and its folder /gone no longer exists, so it cannot be reopened.',
      });
      expect(spawned).toEqual([]);
    });

    test('reports a resume whose message never reaches the transcript, or that fails', async () => {
      expect(await adapter([]).send?.(ref, 'run the audit', context)).toMatchObject({
        ok: false,
        reason: 'not_delivered',
      });
      expect(await adapter([], 1).send?.(ref, 'run the audit', context)).toMatchObject({
        ok: false,
      });
    });

    test('uses the inbox instead when the session starts running before the resume', async () => {
      let reads = 0;
      const racing = adapter(() =>
        reads++
          ? [{ sessionId: 'cli-b2', status: 'idle', name: 'woodpecker', owner: 'cli', pid: 7 }]
          : []
      );
      expect(await racing.send?.(ref, 'run the audit', user)).toMatchObject({
        ok: false,
        reason: 'unsupported',
      });
      expect(spawned.map((entry) => entry.args)).not.toContainEqual(
        expect.arrayContaining(['--resume'])
      );
    });
  });

  test.each(['unknown', undefined] as const)(
    'send does not relay or resume a live %s owner',
    async (owner) => {
      const driver = adapter([
        { sessionId: 'cli-a1', status: 'busy', name: 'lakehouse loader', pid: 1, owner },
      ]);
      expect(
        await driver.send?.({ adapter: 'claude-desktop', id: 'local_a1' }, 'next', user)
      ).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
      expect(
        await driver.steer!({ adapter: 'claude-desktop', id: 'local_a1' }, 'next', user)
      ).toMatchObject({
        ok: false,
        reason: 'unreachable',
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

  test('keeps what a waiting session waits for', async () => {
    expect(
      await readLiveClaudeSessions(
        spawnWith(
          '[{"pid":1,"sessionId":"cli-a1","status":"waiting","waitingFor":"permission prompt"}]'
        ),
        '/missing-claude-registrations'
      )
    ).toEqual([
      {
        pid: 1,
        sessionId: 'cli-a1',
        status: 'waiting',
        waitingFor: 'permission prompt',
        owner: 'unknown',
      },
    ]);
  });

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
  test.each(['', '  Final Claude message 🔬\n'.repeat(400)])(
    'exposes only an explicit top-level turn end with its verbatim message: %s',
    (message) => {
      const stamp = '2026-10-08T10:00:00.000Z';
      const entry = (uuid: string, text: string, stop: string, isSidechain = false) =>
        JSON.stringify({
          uuid,
          type: 'assistant',
          timestamp: stamp,
          isSidechain,
          message: { stop_reason: stop, content: [{ type: 'text', text }] },
        });
      expect(
        claudeTranscriptState(
          [
            entry('tool', 'Earlier commentary', 'tool_use'),
            entry('side', 'Nested final', 'end_turn', true),
            entry('ended-turn', message, 'end_turn'),
          ],
          0
        )
      ).toMatchObject({
        turnEnds: [{ id: 'ended-turn', at: Date.parse(stamp), message }],
      });
    }
  );

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

  test('replies with everything the latest turn said, across notices and subagents mid-turn', () => {
    const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
    const assistant = (stop: string, text?: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          stop_reason: stop,
          content: text ? [{ type: 'text', text }] : [{ type: 'tool_use', name: 'Bash' }],
        },
      });
    const lines = [
      user('earlier task'),
      assistant('end_turn', 'Earlier answer.'),
      user('Neo asks: ship the fix'),
      assistant('tool_use', 'Opened https://github.com/o/r/pull/7.'),
      assistant('tool_use'),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Subagent notes.' }] },
      }),
      user('<task-notification>CI finished</task-notification>'),
      assistant('end_turn', 'Done.'),
    ];
    expect(claudeTranscriptState(lines).reply).toBe(
      'Opened https://github.com/o/r/pull/7.\n\nDone.'
    );
    expect(claudeTranscriptState([...lines, user('next task')]).reply).toBe(
      'Opened https://github.com/o/r/pull/7.\n\nDone.'
    );
    expect(
      claudeTranscriptState([...lines, user('next task'), assistant('tool_use', 'On it.')]).reply
    ).toBe('On it.');
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
    expect(claudeInputEvidence([input], receipt, 'cli-a1')).toEqual({
      receipt,
      state: 'pending',
      transcriptState: 'accepted',
    });
    expect(claudeInputEvidence([input, reply(0, 'tool_use')], receipt, 'cli-a1')).toEqual({
      receipt,
      state: 'pending',
      transcriptState: 'accepted',
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

  test('a later input bounds evidence without proving the earlier transcript completed', () => {
    const next = JSON.stringify({
      type: 'user',
      uuid: 'next',
      timestamp: '2026-10-14T10:00:02.000Z',
      message: { content: 'another task' },
    });
    expect(
      claudeInputEvidence([input, reply(0, 'tool_use'), next], receipt, 'cli-a1')
    ).toMatchObject({
      state: 'observed',
      transcriptState: 'accepted',
    });
    expect(claudeInputEvidence([input, reply(0), next], receipt, 'cli-a1')).toMatchObject({
      state: 'observed',
      transcriptState: 'completed',
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
      transcriptState: 'accepted',
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

describe('native Desktop message confirmation', () => {
  test('a queued native send stays pending after the confirm window and confirms from a later transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-queued-'));
    const folder = join(root, '-synthetic');
    mkdirSync(folder);
    const target = {
      sessionId: 'local_target',
      cliSessionId: 'target',
      cwd: '/synthetic',
      title: 'worker',
      isArchived: false,
      lastActivityAt: 0,
    };
    const helper = {
      ...target,
      sessionId: 'local_helper',
      cliSessionId: 'helper',
      title: 'desktop-wake',
    };
    const targetPath = join(folder, 'target.jsonl');
    const helperPath = join(folder, 'helper.jsonl');
    writeFileSync(
      targetPath,
      JSON.stringify({
        type: 'user',
        uuid: 'old-same-message',
        timestamp: new Date(0).toISOString(),
        message: {
          content:
            '<cross-session-message from="local_helper" name="desktop-wake">\nSynthetic queued task\nExact tail\n</cross-session-message>',
        },
      }) + '\n'
    );
    writeFileSync(helperPath, '');
    const message = 'Synthetic queued task\nExact tail';
    let elapsed = 0;
    const deps = {
      projectsDir: root,
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms;
      },
      spawn: ((args: string[]) => {
        appendFileSync(
          helperPath,
          JSON.stringify({
            type: 'user',
            uuid: 'helper-request',
            message: {
              content: `<cross-session-message from="relay">\n${args.at(-1)}\n</cross-session-message>`,
            },
          }) + '\n'
        );
        return {
          stdout: new Response('Request queued').body,
          stderr: new Response('').body,
          exited: Promise.resolve(0),
          kill: () => {},
        };
      }) as SpawnFn,
    } as ClaudeDesktopAdapterDeps;
    try {
      const sent = await relayNativeDesktopMessage(
        target,
        helper,
        [
          {
            sessionId: 'helper',
            name: 'desktop-wake',
            status: 'running',
            pid: 1,
            owner: 'desktop',
          },
        ],
        message,
        deps
      );
      expect(sent).toMatchObject({
        ok: true,
        value: {
          delivered: false,
          unconfirmed: true,
          receipt: { executionId: 'target', inputId: expect.any(String) },
        },
      });
      expect(elapsed).toBeGreaterThanOrEqual(28_000);
      if (!sent.ok || !sent.value.receipt) throw new Error('Missing queued receipt');
      expect(sent.value.confirmedAt).toBeUndefined();
      const receipt = sent.value.receipt;
      for (const [from, text] of [
        ['local_other', message],
        ['local_helper', 'Synthetic queued task\nDifferent tail'],
      ]) {
        appendFileSync(
          targetPath,
          JSON.stringify({
            type: 'user',
            uuid: `unrelated-${from}`,
            timestamp: new Date(elapsed).toISOString(),
            message: {
              content: `<cross-session-message from="${from}" name="desktop-wake">\n${text}\n</cross-session-message>`,
            },
          }) + '\n'
        );
      }
      expect(await readClaudeInputEvidence(target, deps, receipt)).toEqual({
        receipt,
        state: 'pending',
      });
      elapsed += 120_000;
      expect(await readClaudeInputEvidence(target, deps, receipt)).toEqual({
        receipt,
        state: 'pending',
      });
      appendFileSync(
        targetPath,
        JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(2 * 1024 * 1024) } }) +
          '\n'
      );
      appendFileSync(
        targetPath,
        JSON.stringify({
          type: 'user',
          uuid: 'later-target-input',
          timestamp: new Date(elapsed).toISOString(),
          message: {
            content: `<cross-session-message from="local_helper" name="desktop-wake">\n${message}\n</cross-session-message>`,
          },
        }) + '\n'
      );
      expect(await readClaudeInputEvidence(target, deps, receipt)).toMatchObject({
        receipt,
        state: 'pending',
        transcriptState: 'accepted',
      });
      appendFileSync(
        targetPath,
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(elapsed + 1).toISOString(),
          message: {
            content: [{ type: 'text', text: 'Synthetic completion' }],
            stop_reason: 'end_turn',
          },
        }) + '\n'
      );
      expect(await readClaudeInputEvidence(target, deps, receipt)).toMatchObject({
        receipt,
        state: 'observed',
        transcriptState: 'completed',
        exchange: [
          { role: 'user', text: expect.stringContaining(message) },
          { role: 'agent', text: 'Synthetic completion' },
        ],
      });
      expect(
        await readClaudeInputEvidence({ ...target, cliSessionId: 'other' }, deps, receipt)
      ).toEqual({ receipt, state: 'unavailable' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires the actual helper, user receipt and complete message rather than a matching prefix', () => {
    const message = 'Same opening line\nComplete quoted "tail" 😀';
    const entry = (helper: string, text: string, type = 'user') =>
      JSON.stringify({
        type,
        uuid: 'native-task',
        timestamp: '2026-10-22T23:00:00.000Z',
        message: {
          content: `<system-reminder>Desktop</system-reminder>\n<cross-session-message from="${helper}" name="desktop-wake">\n${text}\n</cross-session-message>`,
        },
      });
    expect(claudeNativeInput([entry('local_helper', message)], 'local_helper', message)).toEqual({
      inputId: 'native-task',
      at: Date.parse('2026-10-22T23:00:00.000Z'),
    });
    expect(
      claudeNativeInput([entry('local_other', message)], 'local_helper', message)
    ).toBeUndefined();
    expect(
      claudeNativeInput(
        [entry('local_helper', 'Same opening line\nDifferent tail')],
        'local_helper',
        message
      )
    ).toBeUndefined();
    expect(
      claudeNativeInput([entry('local_helper', message, 'assistant')], 'local_helper', message)
    ).toBeUndefined();
    expect(claudeNativeInput(['{bad'], 'local_helper', message)).toBeUndefined();
  });
});
