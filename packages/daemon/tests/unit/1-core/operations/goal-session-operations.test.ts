import { describe, expect, test } from 'bun:test';
import { createSessionGoalOperations } from '../../../../src/lib/goals/session-goal-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
const human: OperationCaller = { source: 'rpc' };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const audited: string[] = [];
  const ops = createSessionGoalOperations({
    goals: new SessionGoalRepository(db),
    sessionExists: (sessionId) => ['neo:root', 'neo:other'].includes(sessionId),
    audit: (_caller, toolName) => audited.push(toolName),
  });
  const call = (name: string, input: unknown, caller: OperationCaller = neo) => {
    const op = ops.find((item) => item.name === name)!;
    return op.execute(op.inputSchema.parse(input), caller) as Promise<Record<string, any>>;
  };
  return { db, call, audited };
}

describe('session-owned goals', () => {
  test('root Neo creates, reads and lists its own goal; a goal needs metrics or a done-test', async () => {
    const { db, call } = setup();
    expect(await call('goal.session.create', { title: 'Grow OAP' })).toEqual({
      accepted: false,
      reason: 'done_test_required: give the goal metrics or a written doneTest.',
    });
    const created = await call('goal.session.create', {
      title: 'Grow OAP',
      doneTest: 'Three outside projects run an OAP adapter',
      mandateRef: 'mandate.md#oap-adoption',
    });
    expect(created.goal).toMatchObject({
      ownerSessionId: 'neo:root',
      status: 'active',
      doneTest: 'Three outside projects run an OAP adapter',
      mandateRef: 'mandate.md#oap-adoption',
    });
    expect((await call('goal.session.get', { goalId: created.goal.id })).goal.title).toBe(
      'Grow OAP'
    );
    expect(
      (await call('goal.session.list', {})).goals.map((goal: { title: string }) => goal.title)
    ).toEqual(['Grow OAP']);
    expect(
      db
        .prepare('SELECT event_type, source, space_id FROM space_goal_events WHERE goal_id = ?')
        .all(created.goal.id)
    ).toEqual([{ event_type: 'created', source: 'neo', space_id: null }]);
    db.close();
  });

  test('another session cannot reach the goal, and a human names the owner', async () => {
    const { db, call } = setup();
    const created = await call('goal.session.create', { title: 'Ship', metrics: { adopters: 0 } });
    const other: OperationCaller = { source: 'mcp', sessionId: 'neo:other', role: 'neo' };
    expect(await call('goal.session.get', { goalId: created.goal.id }, other)).toEqual({
      accepted: false,
      reason: 'goal_not_found',
    });
    expect(await call('goal.session.list', { ownerSessionId: 'neo:root' }, other)).toMatchObject({
      accepted: false,
      reason: expect.stringContaining('owner_denied'),
    });
    expect(await call('goal.session.list', {}, human)).toMatchObject({
      reason: expect.stringContaining('owner_unresolved'),
    });
    expect(
      (
        await call(
          'goal.session.get',
          { ownerSessionId: 'neo:root', goalId: created.goal.id },
          human
        )
      ).goal.id
    ).toBe(created.goal.id);
    expect(
      await call(
        'goal.session.create',
        { ownerSessionId: 'neo:typo', title: 'X', doneTest: 'Y' },
        human
      )
    ).toEqual({ accepted: false, reason: 'owner_unknown: no session neo:typo.' });
    db.close();
  });

  test('completing a goal records it, closes it from the default list, and keeps the done-test rule', async () => {
    const { db, call, audited } = setup();
    const created = await call('goal.session.create', { title: 'Ship', doneTest: 'Released' });
    expect(await call('goal.session.update', { goalId: created.goal.id })).toEqual({
      accepted: false,
      reason: 'nothing_to_update: name at least one field to change.',
    });
    expect(
      await call('goal.session.update', { goalId: created.goal.id, doneTest: null })
    ).toMatchObject({ reason: expect.stringContaining('done_test_required') });
    const updated = await call(
      'goal.session.update',
      { ownerSessionId: 'neo:root', goalId: created.goal.id, status: 'completed', progress: 100 },
      human
    );
    expect(updated.goal).toMatchObject({
      status: 'completed',
      progress: 100,
      completedAt: expect.any(Number),
    });
    expect((await call('goal.session.list', {})).goals).toEqual([]);
    expect(
      (await call('goal.session.update', { goalId: created.goal.id, status: 'active' })).goal
    ).toMatchObject({ status: 'active', completedAt: null });
    await call('goal.session.update', { goalId: created.goal.id, status: 'completed' });
    expect((await call('goal.session.list', { includeClosed: true })).goals).toHaveLength(1);
    expect(
      db
        .prepare(
          'SELECT event_type, source FROM space_goal_events WHERE goal_id = ? ORDER BY rowid'
        )
        .all(created.goal.id)
    ).toEqual([
      { event_type: 'created', source: 'neo' },
      { event_type: 'status_changed', source: 'human' },
      { event_type: 'status_changed', source: 'neo' },
      { event_type: 'status_changed', source: 'neo' },
    ]);
    expect(audited).toEqual([
      'goal.session.create',
      'goal.session.update',
      'goal.session.update',
      'goal.session.update',
    ]);
    db.close();
  });

  test('Space goal reads never see a session goal', async () => {
    const { db, call } = setup();
    const created = await call('goal.session.create', { title: 'Ship', doneTest: 'Released' });
    const spaceGoals = new SpaceGoalRepository(db);
    expect(spaceGoals.getById(created.goal.id)).toBeNull();
    expect(spaceGoals.listAllActive()).toEqual([]);
    db.close();
  });
});
