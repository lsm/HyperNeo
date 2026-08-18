import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import {
  canTransition,
  assertValidTransition,
  VALID_TRANSITIONS,
} from '../../../../src/lib/space/runtime/workflow-run-status-machine.ts';
import type { WorkflowRunStatus } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  runMigrations(db, () => {});
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

function seedSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function createWorkflowAndRun(db: BunDatabase, spaceId: string): { runId: string } {
  const workflowRepo = new SpaceWorkflowRepository(db);
  const workflow = workflowRepo.createWorkflow({
    spaceId,
    name: 'Test Workflow',
    description: '',
    nodes: [],
    transitions: [],
    startNodeId: '',
    rules: [],
    completionAutonomyLevel: 3,
  });
  const runRepo = new SpaceWorkflowRunRepository(db);
  const run = runRepo.createRun({ spaceId, workflowId: workflow.id, title: 'Test Run' });
  return { runId: run.id };
}

const SPACE = 'space-lifecycle-1';
let db: BunDatabase;
let runRepo: SpaceWorkflowRunRepository;

beforeEach(() => {
  db = makeDb();
  seedSpace(db, SPACE);
  runRepo = new SpaceWorkflowRunRepository(db);
});

afterEach(() => {
  db.close();
});

describe('canTransition', () => {
  test('1. pending → in_progress is valid', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true);
  });

  test('2. pending → cancelled is valid', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
  });

  test('3. in_progress → completed is valid', () => {
    expect(canTransition('in_progress', 'done')).toBe(true);
  });

  test('4. in_progress → needs_attention is valid', () => {
    expect(canTransition('in_progress', 'blocked')).toBe(true);
  });

  test('5. in_progress → cancelled is valid', () => {
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
  });

  test('6. needs_attention → in_progress is valid (human resolved)', () => {
    expect(canTransition('blocked', 'in_progress')).toBe(true);
  });

  test('7. needs_attention → cancelled is valid', () => {
    expect(canTransition('blocked', 'cancelled')).toBe(true);
  });

  test('8. done → in_progress is valid (reopen); all other targets are invalid', () => {
    expect(canTransition('done', 'in_progress')).toBe(true);
    for (const to of ['pending', 'done', 'cancelled', 'blocked'] as WorkflowRunStatus[]) {
      expect(canTransition('done', to)).toBe(false);
    }
  });

  test('9. cancelled → in_progress is valid (reopen); all other targets are invalid', () => {
    expect(canTransition('cancelled', 'in_progress')).toBe(true);
    for (const to of ['pending', 'done', 'cancelled', 'blocked'] as WorkflowRunStatus[]) {
      expect(canTransition('cancelled', to)).toBe(false);
    }
  });

  test('10. pending → completed is invalid (must go through in_progress)', () => {
    expect(canTransition('pending', 'done')).toBe(false);
  });

  test('11. pending → needs_attention is invalid', () => {
    expect(canTransition('pending', 'blocked')).toBe(false);
  });

  test('VALID_TRANSITIONS contains all 5 lifecycle statuses', () => {
    const statuses = Object.keys(VALID_TRANSITIONS);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('in_progress');
    expect(statuses).toContain('blocked');
    expect(statuses).toContain('done');
    expect(statuses).toContain('cancelled');
    expect(statuses).toHaveLength(5);
  });
});

describe('assertValidTransition', () => {
  test('12. includes run ID in error message when provided', () => {
    expect(() => assertValidTransition('done', 'cancelled', 'run-abc')).toThrow(/run run-abc/);
  });

  test('13. error lists the allowed set when the target is not permitted', () => {
    expect(() => assertValidTransition('cancelled', 'pending')).toThrow(/in_progress/);
  });

  test('does not throw on valid transition', () => {
    expect(() => assertValidTransition('pending', 'in_progress')).not.toThrow();
    expect(() => assertValidTransition('in_progress', 'done')).not.toThrow();
    expect(() => assertValidTransition('blocked', 'in_progress')).not.toThrow();
    expect(() => assertValidTransition('done', 'in_progress')).not.toThrow();
    expect(() => assertValidTransition('cancelled', 'in_progress')).not.toThrow();
  });
});

describe('SpaceWorkflowRunRepository.transitionStatus', () => {
  test('14. persists the new status on a valid transition', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    const updated = runRepo.transitionStatus(runId, 'in_progress');
    expect(updated.status).toBe('in_progress');
    expect(runRepo.getRun(runId)?.status).toBe('in_progress');
  });

  test('15. sets completed_at when transitioning to completed', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(runId, 'in_progress');
    const before = Date.now();
    const updated = runRepo.transitionStatus(runId, 'done');
    const after = Date.now();
    expect(updated.completedAt).toBeDefined();
    expect(updated.completedAt!).toBeGreaterThanOrEqual(before);
    expect(updated.completedAt!).toBeLessThanOrEqual(after);
  });

  test('16. sets completed_at when transitioning to cancelled', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    const before = Date.now();
    const updated = runRepo.transitionStatus(runId, 'cancelled');
    const after = Date.now();
    expect(updated.completedAt).toBeDefined();
    expect(updated.completedAt!).toBeGreaterThanOrEqual(before);
    expect(updated.completedAt!).toBeLessThanOrEqual(after);
  });

  test('17. throws when the run is not found', () => {
    expect(() => runRepo.transitionStatus('nonexistent-run', 'in_progress')).toThrow(
      /WorkflowRun not found/
    );
  });

  test('18. throws on invalid transition in_progress → pending', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(runId, 'in_progress');
    expect(() => runRepo.transitionStatus(runId, 'pending')).toThrow(
      /Invalid workflow run status transition/
    );
    expect(runRepo.getRun(runId)?.status).toBe('in_progress');
  });

  test('19. allows reopen transition completed → in_progress', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(runId, 'in_progress');
    runRepo.transitionStatus(runId, 'done');

    const reopened = runRepo.transitionStatus(runId, 'in_progress');
    expect(reopened.status).toBe('in_progress');
    expect(runRepo.getRun(runId)?.status).toBe('in_progress');

    runRepo.transitionStatus(runId, 'done');
    expect(() => runRepo.transitionStatus(runId, 'cancelled')).toThrow(
      /Invalid workflow run status transition/
    );
  });
});

describe('getRehydratableRuns', () => {
  test('20. returns in_progress runs', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(runId, 'in_progress');
    const runs = runRepo.getRehydratableRuns(SPACE);
    expect(runs.map((r) => r.id)).toContain(runId);
  });

  test('21. returns needs_attention runs (blocked at human gate, need executor after restart)', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(runId, 'in_progress');
    runRepo.transitionStatus(runId, 'blocked');
    const runs = runRepo.getRehydratableRuns(SPACE);
    expect(runs.map((r) => r.id)).toContain(runId);
  });

  test('22. excludes pending, completed, and cancelled runs', () => {
    const { runId: pendingId } = createWorkflowAndRun(db, SPACE);

    const { runId: completedId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(completedId, 'in_progress');
    runRepo.transitionStatus(completedId, 'done');

    const { runId: cancelledId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(cancelledId, 'cancelled');

    const runs = runRepo.getRehydratableRuns(SPACE);
    const ids = runs.map((r) => r.id);
    expect(ids).not.toContain(pendingId);
    expect(ids).not.toContain(completedId);
    expect(ids).not.toContain(cancelledId);
  });

  test('23. needs_attention → in_progress makes run processable again (tick-loop eligible)', () => {
    const { runId } = createWorkflowAndRun(db, SPACE);
    runRepo.transitionStatus(runId, 'in_progress');
    runRepo.transitionStatus(runId, 'blocked');

    runRepo.transitionStatus(runId, 'in_progress');

    const run = runRepo.getRun(runId);
    expect(run?.status).toBe('in_progress');

    const runs = runRepo.getRehydratableRuns(SPACE);
    expect(runs.map((r) => r.id)).toContain(runId);
  });
});
