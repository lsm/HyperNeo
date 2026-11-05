import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeCodeGroups,
  createClaudeCodeAdapter,
  shareInFlight,
} from '../../../../src/lib/drivers/claude-code-adapter';
import { buildClaudeDesktopGroups } from '../../../../src/lib/drivers/claude-desktop-adapter';
import type { WorkChatMatch } from '../../../../src/storage/work-chat-search';

const chat = (sessionId: string, text: string, role = 'user'): WorkChatMatch => ({
  kind: 'claude',
  sessionId,
  taskId: null,
  hits: 2,
  lastHitAt: 500,
  score: 100.1,
  snippets: [{ match: 'exact', messageId: `${sessionId}-m`, sessionId, role, at: 500, text }],
});

describe('buildClaudeCodeGroups', () => {
  test('lists CLI sessions found by content, leaving Desktop sessions to their adapter', () => {
    const groups = buildClaudeCodeGroups(
      [chat('cli-1', 'plan the   heron rollout'), chat('desk-1', 'heron in desktop')],
      new Set(['desk-1']),
      { text: 'heron', includeClosed: false, limit: 20 },
      'laptop'
    );
    expect(groups).toMatchObject([
      {
        place: { machine: 'laptop', name: 'Claude Code' },
        adapters: ['claude-code'],
        work: [
          {
            ref: { adapter: 'claude-code', id: 'cli-1' },
            title: 'plan the heron rollout',
            hits: 2,
            snippets: [{ handle: { sessionId: 'cli-1', messageId: 'cli-1-m' } }],
          },
        ],
      },
    ]);
    expect(
      buildClaudeCodeGroups(
        [chat('cli-1', 'x')],
        new Set(),
        { folder: '/x', includeClosed: false, limit: 5 },
        'laptop'
      )
    ).toEqual([]);
  });
});

describe('createClaudeCodeAdapter', () => {
  test('registers live owner-verified status with the existing transcript folder lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-status-wire-'));
    const sessionId = crypto.randomUUID();
    const inputId = crypto.randomUUID();
    const ref = { adapter: 'claude-code', id: sessionId };
    const receipt = { executionId: sessionId, inputId };
    let owner: 'cli' | 'desktop' | 'unknown' = 'cli';
    let status = 'busy';
    try {
      mkdirSync(join(dir, '-focus-project'));
      writeFileSync(
        join(dir, '-focus-project', `${sessionId}.jsonl`),
        [
          JSON.stringify({
            cwd: '/focus/project',
            type: 'user',
            uuid: inputId,
            timestamp: '2026-10-16T20:00:00Z',
            message: { content: 'question' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-10-16T20:00:01Z',
            message: { content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' },
          }),
        ].join('\n')
      );
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => [],
        desktopSessions: async () => new Set(),
        liveSessions: async () => [{ sessionId, pid: 456, owner, status }],
      });
      expect(adapter.capabilities).toEqual(['find', 'status']);
      expect(await adapter.status!(ref, 0, receipt)).toMatchObject({
        ok: true,
        value: {
          ref,
          status: 'running',
          place: { folder: '/focus/project' },
          inputEvidence: { receipt, state: 'observed' },
          lastReply: 'answer',
        },
      });
      owner = 'desktop';
      expect(await adapter.status!(ref)).toMatchObject({ ok: false, reason: 'unsupported' });
      owner = 'unknown';
      expect(await adapter.status!(ref)).toMatchObject({ ok: false, reason: 'unreachable' });
      owner = 'cli';
      status = 'future-status';
      expect(await adapter.status!(ref)).toMatchObject({ ok: false, reason: 'unreachable' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns a typed refusal when live CLI discovery fails', async () => {
    let probes = 0;
    const adapter = createClaudeCodeAdapter({
      machine: 'laptop',
      searchChats: async () => [],
      desktopSessions: async () => new Set(),
      sendInbox: async () => {
        throw new Error('Must not write after a failed probe');
      },
      liveSessions: async () => {
        probes++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('CLI timed out or is unavailable');
      },
    });
    const ref = { adapter: 'claude-code', id: 'session' };
    const [status, sent] = await Promise.all([
      adapter.status!(ref),
      adapter.send!(ref, 'Do not send', { from: 'session:origin', caller: { source: 'rpc' } }),
    ]);
    expect(status).toEqual({
      ok: false,
      reason: 'not_delivered',
      detail: 'Could not inspect live Claude sessions: CLI timed out or is unavailable',
    });
    expect(sent).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(probes).toBe(1);
  });

  test('discovers CLI folders without a search and links content hits to their actual folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-places-'));
    try {
      mkdirSync(join(dir, 'encoded'));
      writeFileSync(
        join(dir, 'encoded', 'cli-2.jsonl'),
        `${JSON.stringify({ cwd: '/travel/japan' })}\n`
      );
      writeFileSync(
        join(dir, 'encoded', 'desk-1.jsonl'),
        `${JSON.stringify({ cwd: '/desktop' })}\n`
      );
      writeFileSync(join(dir, 'encoded', 'broken.jsonl'), 'invalid\n');
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => [chat('cli-2', 'itinerary')],
        desktopSessions: async () => new Set(['desk-1']),
      });
      const query = { includeClosed: false, limit: 20 };
      expect((await adapter.find(query)).map((group) => group.place.folder)).toEqual([
        '/travel/japan',
      ]);
      const found = await adapter.find({ ...query, text: 'itinerary', folder: '/travel/japan' });
      expect(found[0].work[0]).toMatchObject({
        ref: { id: 'cli-2' },
        place: { folder: '/travel/japan' },
      });
      expect(await adapter.find({ ...query, folder: '/unrelated' })).toEqual([]);
      rmSync(join(dir, 'encoded', 'cli-2.jsonl'));
      expect(await adapter.find(query)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('excludes temporary and owned folders before limits and refreshes ownership with cached transcripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-places-'));
    const owned = new Set(['coordinator']);
    const records = [
      ['cli', '/real/project'],
      ['temp', '/tmp/hyperneo-neo-context/task'],
      ['coordinator', '/data/Neo/.coordinators/task'],
    ];
    try {
      mkdirSync(join(dir, 'encoded'));
      for (const [id, cwd] of records) {
        writeFileSync(join(dir, 'encoded', `${id}.jsonl`), `${JSON.stringify({ cwd })}\n`);
      }
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => records.map(([id]) => chat(id, 'project')),
        desktopSessions: async () => new Set(),
        ownedSessions: () => owned,
      });
      const query = { includeClosed: false, limit: 1 };
      expect((await adapter.find(query)).map((group) => group.place.folder)).toEqual([
        '/real/project',
      ]);
      const matches = await adapter.find({ ...query, text: 'project' });
      expect(matches.flatMap((group) => group.work.map((work) => work.ref.id))).toEqual(['cli']);
      expect(await adapter.find({ ...query, folder: '/tmp/hyperneo-neo-context/task' })).toEqual(
        []
      );
      owned.add('cli');
      expect(await adapter.find(query)).toEqual([]);
      expect(await adapter.find({ ...query, text: 'project' })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores transcripts outside the feed window and evicts expired cached folders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-places-'));
    try {
      mkdirSync(join(dir, 'encoded'));
      const path = join(dir, 'encoded', 'cli.jsonl');
      writeFileSync(path, `${JSON.stringify({ cwd: '/real/project' })}\n`);
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => [],
        desktopSessions: async () => new Set(),
      });
      const query = { includeClosed: false, limit: 20 };
      expect(await adapter.find(query)).toHaveLength(1);
      const old = new Date(Date.now() - 91 * 24 * 60 * 60_000);
      utimesSync(path, old, old);
      expect(await adapter.find(query)).toEqual([]);
      expect(
        await createClaudeCodeAdapter({
          projectsDir: dir,
          machine: 'laptop',
          searchChats: async () => [],
          desktopSessions: async () => new Set(),
        }).find(query)
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finds the folder of a transcript whose first lines carry no cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-places-'));
    try {
      mkdirSync(join(dir, 'encoded'));
      writeFileSync(
        join(dir, 'encoded', 'late.jsonl'),
        `${JSON.stringify({ type: 'summary', summary: 'x'.repeat(40_000) })}\n${JSON.stringify({ cwd: '/late/project' })}\n`
      );
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => [],
        desktopSessions: async () => new Set(),
      });
      expect(
        (await adapter.find({ includeClosed: false, limit: 20 })).map((group) => group.place.folder)
      ).toEqual(['/late/project']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retries a transcript it could not read instead of hiding its folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-places-'));
    const path = join(dir, 'encoded', 'locked.jsonl');
    try {
      mkdirSync(join(dir, 'encoded'));
      writeFileSync(path, `${JSON.stringify({ cwd: '/locked/project' })}\n`);
      chmodSync(path, 0o000);
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => [],
        desktopSessions: async () => new Set(),
      });
      const query = { includeClosed: false, limit: 20 };
      expect(await adapter.find(query)).toEqual([]);
      chmodSync(path, 0o644);
      expect((await adapter.find(query)).map((group) => group.place.folder)).toEqual([
        '/locked/project',
      ]);
      writeFileSync(path, `${JSON.stringify({ cwd: '/moved/project' })}\n`);
      utimesSync(path, new Date(), new Date(Date.now() + 5_000));
      chmodSync(path, 0o000);
      expect(await adapter.find(query)).toEqual([]);
      chmodSync(path, 0o644);
      expect((await adapter.find(query)).map((group) => group.place.folder)).toEqual([
        '/moved/project',
      ]);
    } finally {
      chmodSync(path, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('follows a symlinked project folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-places-'));
    const real = mkdtempSync(join(tmpdir(), 'claude-real-'));
    try {
      writeFileSync(join(real, 'linked.jsonl'), `${JSON.stringify({ cwd: '/linked/project' })}\n`);
      symlinkSync(real, join(dir, 'encoded'));
      const adapter = createClaudeCodeAdapter({
        projectsDir: dir,
        machine: 'laptop',
        searchChats: async () => [],
        desktopSessions: async () => new Set(),
      });
      expect(
        (await adapter.find({ includeClosed: false, limit: 20 })).map((group) => group.place.folder)
      ).toEqual(['/linked/project']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test('only searches when asked for text', async () => {
    const searched: string[] = [];
    const adapter = createClaudeCodeAdapter({
      machine: 'laptop',
      searchChats: async (text) => {
        searched.push(text);
        return [chat('cli-2', 'heron')];
      },
      desktopSessions: async () => new Set(),
    });
    expect(await adapter.find({ includeClosed: false, limit: 5 })).toEqual([]);
    expect(
      (await adapter.find({ text: 'heron', includeClosed: false, limit: 5 }))[0]?.work
    ).toHaveLength(1);
    expect(searched).toEqual(['heron']);
  });
});

describe('buildClaudeDesktopGroups with content hits', () => {
  test('lists a Desktop session whose transcript matched, with its snippet', () => {
    const groups = buildClaudeDesktopGroups(
      [
        {
          sessionId: 'local_a',
          cliSessionId: 'desk-1',
          cwd: '/focus/neokai',
          title: 'Untitled',
          isArchived: false,
          lastActivityAt: 1,
        },
        {
          sessionId: 'local_b',
          cliSessionId: 'desk-2',
          cwd: '/focus/neokai',
          title: 'Other',
          isArchived: false,
          lastActivityAt: 2,
        },
      ],
      [],
      { text: 'heron', includeClosed: false, limit: 20 },
      { machine: 'laptop' },
      new Map([['desk-1', chat('desk-1', 'heron notes')]])
    );
    expect(groups.flatMap((group) => group.work)).toMatchObject([
      {
        ref: { adapter: 'claude-desktop', id: 'local_a' },
        hits: 2,
        snippets: [{ text: 'heron notes' }],
      },
    ]);
  });
});

describe('shareInFlight', () => {
  test('concurrent calls join one run, and a call after it settles starts another', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const scan = shareInFlight(async () => {
      runs++;
      await new Promise<void>((resolve) => (release = resolve));
      return runs;
    });
    const both = Promise.all([scan(), scan()]);
    release();
    expect(await both).toEqual([1, 1]);
    const next = scan();
    release();
    expect(await next).toBe(2);
  });
});
