import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session, Space } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  createReturnSessionCloneOperation,
  type ReturnSessionCloneDependencies,
} from '../../../../src/lib/session/clone-return-operation';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let status: string;
let space: Space | null;
let deps: ReturnSessionCloneDependencies;

function seed(id: string, overrides: Partial<Session> = {}): void {
  sessions.createSession({ ...createTestSession(id), workspacePath: '/repo', ...overrides });
}

function deliveryJobs(sessionId: string): Array<Record<string, unknown>> {
  return (
    db
      .prepare(`SELECT payload FROM job_queue WHERE queue = ? ORDER BY created_at`)
      .all(MESSAGE_DELIVERY) as { payload: string }[]
  )
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => payload.sessionId === sessionId);
}

function userRows(sessionId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id = ?`).get(sessionId) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  sessions = new SessionRepository(db);
  status = 'idle';
  space = { id: 'space-1', status: 'active', paused: false, stopped: false } as Space;
  seed('parent');
  seed('clone', { parentSessionId: 'parent', title: 'Parent · 分身' });
  deps = {
    getSession: (id) => sessions.getSession(id),
    getSpace: async () => space,
    getSessionStatus: () => status,
    markReturned: (id, returnedAt) => {
      const current = sessions.getSession(id)!;
      sessions.updateSession(id, { metadata: { ...current.metadata, clone: { returnedAt } } });
    },
    getDatabase: () => db,
    getSdkMessageRepo: () => new SDKMessageRepository(db),
    jobQueue: new JobQueueRepository(db),
  };
});

afterEach(() => db.close());

function run(summary: string, caller: { source: 'mcp' | 'rpc'; sessionId?: string }) {
  return createReturnSessionCloneOperation(deps).execute({ summary }, caller);
}

describe('session.clone.return', () => {
  test("an RPC caller cannot return on a clone's behalf", async () => {
    expect(await run('done', { source: 'rpc' })).toMatchObject({
      accepted: false,
      reason: 'caller_session_required',
    });
  });

  test('a session without a parent is not a clone', async () => {
    expect(await run('done', { source: 'mcp', sessionId: 'parent' })).toMatchObject({
      reason: 'not_a_clone',
    });
  });

  test('an inactive parent is unavailable', async () => {
    sessions.updateSession('parent', { status: 'archived' });
    seed('orphan-parent', { status: 'ended' });
    seed('clone-2', { parentSessionId: 'orphan-parent' });
    expect(await run('done', { source: 'mcp', sessionId: 'clone-2' })).toMatchObject({
      reason: 'parent_unavailable',
    });
    expect(deliveryJobs('orphan-parent')).toEqual([]);
  });

  test('a paused Space blocks the report', async () => {
    seed('agent', { context: { spaceId: 'space-1' } });
    seed('agent-clone', { parentSessionId: 'agent' });
    space = { ...space, paused: true } as Space;
    expect(await run('done', { source: 'mcp', sessionId: 'agent-clone' })).toMatchObject({
      reason: 'parent_unavailable',
    });
  });

  test('an idle parent gets a new turn; a processing parent is steered', async () => {
    const idle = await run('Found the bug in the retry loop.', {
      source: 'mcp',
      sessionId: 'clone',
    });
    expect(idle).toMatchObject({ accepted: true, parentSessionId: 'parent', mechanics: 'turn' });
    const [job] = deliveryJobs('parent');
    expect(job).toMatchObject({ sessionId: 'parent' });
    expect(job.injectedMidTurn ?? false).toBe(false);
    expect(userRows('parent')).toBe(1);
    expect(sessions.getSession('clone')?.metadata.clone?.returnedAt).toEqual(expect.any(String));

    status = 'processing';
    const steered = await run('Second finding.', { source: 'mcp', sessionId: 'clone' });
    expect(steered).toMatchObject({ accepted: true, mechanics: 'steer' });
    const jobs = deliveryJobs('parent');
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.injectedMidTurn).toBe(true);
  });

  test('the report carries the clone title and the summary', async () => {
    await run('Summary text.', { source: 'mcp', sessionId: 'clone' });
    const row = db
      .prepare(`SELECT sdk_message FROM sdk_messages WHERE session_id = 'parent'`)
      .get() as { sdk_message: string };
    const text = JSON.stringify(JSON.parse(row.sdk_message).message.content);
    expect(text).toContain('分身 returned: \\"Parent · 分身\\" (clone)');
    expect(text).toContain('Summary text.');
  });

  test('an identical repeat is a no-op; a new summary is a new report', async () => {
    const first = await run('Same.', { source: 'mcp', sessionId: 'clone' });
    const again = await run('Same.', { source: 'mcp', sessionId: 'clone' });
    expect(again).toMatchObject({
      accepted: true,
      messageId: (first as { messageId: string }).messageId,
    });
    expect(userRows('parent')).toBe(1);

    await run('Different.', { source: 'mcp', sessionId: 'clone' });
    expect(userRows('parent')).toBe(2);
  });
});
