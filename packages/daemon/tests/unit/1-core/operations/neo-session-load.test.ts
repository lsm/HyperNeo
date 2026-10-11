import { beforeEach, describe, expect, it } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { withSessionLoad } from '../../../../src/lib/drivers/hyperneo-adapter';
import {
  neoTargetSessionId,
  readNeoIdleSessions,
  readNeoSessionLoad,
  requireIdleNeoTarget,
} from '../../../../src/lib/neo/session-load';

let db: Database;
let raw: BunDatabase;

function session(id: string, folder: string, processing?: string): void {
  const now = new Date().toISOString();
  db.createSession({
    id,
    title: `Title ${id}`,
    workspacePath: folder,
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    type: 'worker',
    config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 4096, temperature: 0.7 },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    ...(processing ? { processingState: JSON.stringify({ status: processing }) } : {}),
  } as unknown as Session);
}

function card(
  id: string,
  status: string,
  target: { targetSessionId?: string; sessionId?: string; driver?: unknown; ref?: unknown }
): void {
  raw
    .prepare(
      `INSERT INTO neo_work (id, request_key, origin_session_id, title, instruction,
         target_session_id, session_id, status, created_at, updated_at)
       VALUES (?, ?, 'neo:root', 'title', 'instruction', ?, ?, ?, 1, 1)`
    )
    .run(id, `neo:root:${id}`, target.targetSessionId ?? null, target.sessionId ?? null, status);
  if (target.driver) {
    raw
      .prepare('INSERT INTO neo_work_driver_targets (work_id, target, ref) VALUES (?, ?, ?)')
      .run(id, JSON.stringify(target.driver), target.ref ? JSON.stringify(target.ref) : null);
  }
}

beforeEach(async () => {
  db = new Database(':memory:');
  await db.initialize(createReactiveDatabase(db));
  raw = db.getDatabase();
});

describe('readNeoSessionLoad', () => {
  it('counts live cards per HyperNeo session across chat and driver cards', () => {
    session('busy-chat', '/repo', 'processing');
    session('quiet-chat', '/repo');
    card('w1', 'proposed', { targetSessionId: 'busy-chat' });
    card('w2', 'queued', { targetSessionId: 'busy-chat', sessionId: 'busy-chat' });
    card('w3', 'queued', {
      driver: { verb: 'send', ref: { adapter: 'hyperneo', id: 'quiet-chat' } },
    });
    card('w4', 'reported', { targetSessionId: 'quiet-chat', sessionId: 'quiet-chat' });
    card('w5', 'queued', {
      driver: { verb: 'send', ref: { adapter: 'hyperneo', daemon: 'tts', id: 'quiet-chat' } },
    });
    card('w6', 'queued', {
      driver: { verb: 'start', adapter: 'codex-desktop', place: { machine: 'm', name: 'x' } },
      ref: { adapter: 'codex-desktop', id: 'thread-1' },
    });

    const load = readNeoSessionLoad(raw).sort((a, b) => a.sessionId.localeCompare(b.sessionId));

    expect(load).toEqual([
      { sessionId: 'busy-chat', liveCards: 2, busy: true },
      { sessionId: 'quiet-chat', liveCards: 1, busy: false },
    ]);
  });

  it('leaves out the card of the request being retried', () => {
    session('chat', '/repo');
    card('w1', 'proposed', { targetSessionId: 'chat' });

    expect(readNeoSessionLoad(raw, 'neo:root:w1')).toEqual([]);
  });
});

describe('readNeoIdleSessions', () => {
  it('offers idle sessions in the same folder that hold no cards', () => {
    session('target', '/repo');
    session('idle', '/repo');
    session('working', '/repo', 'processing');
    session('loaded', '/repo');
    session('elsewhere', '/other');

    const idle = readNeoIdleSessions(raw, 'target', new Set(['target', 'loaded']));

    expect(idle).toEqual([{ sessionId: 'idle', title: 'Title idle' }]);
  });
});

describe('neoTargetSessionId', () => {
  it('resolves the HyperNeo session a proposal lands in', () => {
    expect(neoTargetSessionId('chat', undefined)).toBe('chat');
    expect(neoTargetSessionId(null, { verb: 'send', ref: { adapter: 'hyperneo', id: 's' } })).toBe(
      's'
    );
    expect(
      neoTargetSessionId(null, {
        verb: 'send',
        ref: { adapter: 'hyperneo', daemon: 'tts', id: 's' },
      })
    ).toBeNull();
    expect(
      neoTargetSessionId(null, {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'm', name: 'repo' },
      })
    ).toBeNull();
  });
});

describe('requireIdleNeoTarget', () => {
  const idle = () => [{ sessionId: 'idle-1', title: 'Idle chat' }];
  const load = [{ sessionId: 'chat', liveCards: 2, busy: true }];

  it('refuses a session that holds live cards and names idle ones', () => {
    const result = requireIdleNeoTarget('chat', load, undefined, idle);

    expect('reason' in result && result.reason.reason).toContain(
      'Session chat already holds 2 live cards and is busy'
    );
    expect('reason' in result && result.reason.reason).toContain('idle-1 (Idle chat)');
  });

  it('lets an explicit override queue behind the current work', () => {
    expect(requireIdleNeoTarget('chat', load, true, idle)).toEqual({ value: true });
  });

  it('admits sessions without cards and proposals that start new work', () => {
    expect(requireIdleNeoTarget('other', load, undefined, idle)).toEqual({ value: true });
    expect(requireIdleNeoTarget(null, load, undefined, idle)).toEqual({ value: true });
  });

  it('points to new work when no idle session shares the place', () => {
    const result = requireIdleNeoTarget('chat', load, undefined, () => []);

    expect('reason' in result && result.reason.reason).toContain('work {verb:"start"}');
  });
});

describe('withSessionLoad', () => {
  const work = {
    ref: { adapter: 'hyperneo', id: 's' },
    title: 't',
    place: { machine: 'm', name: 'p' },
    lastActivityAt: 0,
  };

  it('marks live cards and a busy session on a work.find item', () => {
    expect(withSessionLoad({ ...work, status: 'running' }, 2)).toMatchObject({
      liveCards: 2,
      busy: true,
    });
  });

  it('adds nothing to an idle session without cards', () => {
    const result = withSessionLoad({ ...work, status: 'done' }, 0);

    expect(result).not.toHaveProperty('liveCards');
    expect(result).not.toHaveProperty('busy');
  });
});
