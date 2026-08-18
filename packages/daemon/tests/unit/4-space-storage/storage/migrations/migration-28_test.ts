import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { createTables } from '../../../../../src/storage/schema/index.ts';
import {
  GoalRepository,
  getEffectiveMaxPlanningAttempts,
} from '../../../../../src/storage/repositories/goal-repository.ts';
import { noOpReactiveDb } from '../../../../helpers/reactive-database';

function createLegacyGoalsTable(db: BunDatabase): void {
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			progress INTEGER DEFAULT 0,
			linked_task_ids TEXT DEFAULT '[]',
			metrics TEXT DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			planning_attempts INTEGER DEFAULT 0,
			goal_review_attempts INTEGER DEFAULT 0,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);
  db.exec(`PRAGMA foreign_keys = ON`);
}

function insertRoom(db: BunDatabase, id = 'room-1'): void {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at)
		 VALUES ('${id}', 'Test Room', ${now}, ${now})`
  );
}

describe('Migration 28: mission metadata schema additions', () => {
  let testDir: string;
  let db: BunDatabase;

  const HOOK_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-28', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				background_context TEXT,
				instructions TEXT,
				allowed_paths TEXT DEFAULT '[]',
				default_path TEXT,
				default_model TEXT,
				allowed_models TEXT DEFAULT '[]',
				session_ids TEXT DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    insertRoom(db);
  }, HOOK_TIMEOUT_MS);

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, HOOK_TIMEOUT_MS);

  test('migration runs cleanly on fresh DB (no goals table yet)', () => {
    expect(() => runMigrations(db, () => {})).not.toThrow();
    const mmhExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='mission_metric_history'`
      )
      .get();
    const meExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mission_executions'`)
      .get();
    expect(mmhExists).toBeTruthy();
    expect(meExists).toBeTruthy();
  });

  test('migration adds new columns to existing goals table and backfills defaults', () => {
    createLegacyGoalsTable(db);

    const now = Date.now();
    db.exec(
      `INSERT INTO goals (id, room_id, title, description, status, priority, created_at, updated_at)
			 VALUES ('goal-1', 'room-1', 'Old Goal', '', 'active', 'normal', ${now}, ${now})`
    );

    runMigrations(db, () => {});

    const row = db.prepare(`SELECT * FROM goals WHERE id = 'goal-1'`).get() as Record<
      string,
      unknown
    >;
    expect(row.mission_type).toBe('one_shot');
    expect(row.autonomy_level).toBe('supervised');
    expect(row.schedule_paused).toBe(0);
    expect(row.max_consecutive_failures).toBe(3);
    expect(row.max_planning_attempts).toBe(0);
    expect(row.consecutive_failures).toBe(0);
    expect(row.schedule).toBeNull();
    expect(row.next_run_at).toBeNull();
    expect(row.structured_metrics).toBeNull();
  });

  test('migration is idempotent — running twice does not throw', () => {
    createLegacyGoalsTable(db);
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });

  test('CHECK constraint on mission_type is enforced after migration', () => {
    createLegacyGoalsTable(db);
    runMigrations(db, () => {});

    const now = Date.now();
    expect(() => {
      db.exec(
        `INSERT INTO goals (id, room_id, title, description, status, priority, mission_type, autonomy_level, created_at, updated_at)
				 VALUES ('g-ok', 'room-1', 'T', '', 'active', 'normal', 'recurring', 'supervised', ${now}, ${now})`
      );
    }).not.toThrow();

    expect(() => {
      db.exec(
        `INSERT INTO goals (id, room_id, title, description, status, priority, mission_type, autonomy_level, created_at, updated_at)
				 VALUES ('g-bad', 'room-1', 'T', '', 'active', 'normal', 'invalid_type', 'supervised', ${now}, ${now})`
      );
    }).toThrow();
  });

  test('mission_metric_history table has correct schema and cascade delete', () => {
    createLegacyGoalsTable(db);
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO goals (id, room_id, title, description, status, priority, mission_type, autonomy_level, created_at, updated_at)
			 VALUES ('g-cascade', 'room-1', 'Cascade Goal', '', 'active', 'normal', 'one_shot', 'supervised', ${now}, ${now})`
    );
    db.exec(
      `INSERT INTO mission_metric_history (id, goal_id, metric_name, value, recorded_at)
			 VALUES ('mh-1', 'g-cascade', 'velocity', 42.5, 1000)`
    );

    db.exec(`DELETE FROM goals WHERE id = 'g-cascade'`);

    const remaining = db
      .prepare(`SELECT * FROM mission_metric_history WHERE goal_id = 'g-cascade'`)
      .all();
    expect(remaining).toHaveLength(0);
  });

  test('partial unique index on mission_executions prevents two running executions per goal', () => {
    createLegacyGoalsTable(db);
    runMigrations(db, () => {});

    const now = Date.now();
    db.exec(
      `INSERT INTO goals (id, room_id, title, description, status, priority, mission_type, autonomy_level, created_at, updated_at)
			 VALUES ('g-exec', 'room-1', 'Exec Goal', '', 'active', 'normal', 'one_shot', 'supervised', ${now}, ${now})`
    );

    db.exec(
      `INSERT INTO mission_executions (id, goal_id, execution_number, status, task_ids, planning_attempts)
			 VALUES ('e-1', 'g-exec', 1, 'running', '[]', 0)`
    );

    expect(() => {
      db.exec(
        `INSERT INTO mission_executions (id, goal_id, execution_number, status, task_ids, planning_attempts)
				 VALUES ('e-2', 'g-exec', 2, 'running', '[]', 0)`
      );
    }).toThrow();

    db.exec(`UPDATE mission_executions SET status = 'completed' WHERE id = 'e-1'`);
    expect(() => {
      db.exec(
        `INSERT INTO mission_executions (id, goal_id, execution_number, status, task_ids, planning_attempts)
				 VALUES ('e-2', 'g-exec', 2, 'running', '[]', 0)`
      );
    }).not.toThrow();
  });
});

describe('GoalRepository: mission metadata CRUD', () => {
  let db: BunDatabase;
  let repo: GoalRepository;
  let roomId: string;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createTables(db);

    const now = Date.now();
    db.exec(
      `INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'R', ${now}, ${now})`
    );
    roomId = 'room-1';
    repo = new GoalRepository(db, noOpReactiveDb);
  });

  test('createGoal defaults to one_shot / supervised', () => {
    const goal = repo.createGoal({ roomId, title: 'My goal' });
    expect(goal.missionType).toBe('one_shot');
    expect(goal.autonomyLevel).toBe('supervised');
    expect(goal.schedulePaused).toBe(false);
    expect(goal.maxConsecutiveFailures).toBe(3);
    expect(goal.maxPlanningAttempts).toBe(0);
    expect(goal.consecutiveFailures).toBe(0);
  });

  test('createGoal accepts mission V2 params', () => {
    const goal = repo.createGoal({
      roomId,
      title: 'Measurable goal',
      missionType: 'measurable',
      autonomyLevel: 'semi_autonomous',
      maxConsecutiveFailures: 2,
      maxPlanningAttempts: 10,
      structuredMetrics: [{ name: 'velocity', target: 100, current: 0 }],
    });
    expect(goal.missionType).toBe('measurable');
    expect(goal.autonomyLevel).toBe('semi_autonomous');
    expect(goal.maxConsecutiveFailures).toBe(2);
    expect(goal.maxPlanningAttempts).toBe(10);
    expect(goal.structuredMetrics).toHaveLength(1);
    expect(goal.structuredMetrics![0].name).toBe('velocity');
  });

  test('updateGoal updates mission V2 fields', () => {
    const goal = repo.createGoal({ roomId, title: 'G' });

    const updated = repo.updateGoal(goal.id, {
      missionType: 'recurring',
      autonomyLevel: 'semi_autonomous',
      schedule: { expression: '0 * * * *', timezone: 'UTC' },
      schedulePaused: true,
      nextRunAt: 9999,
      consecutiveFailures: 2,
      maxConsecutiveFailures: 5,
    });

    expect(updated?.missionType).toBe('recurring');
    expect(updated?.autonomyLevel).toBe('semi_autonomous');
    expect(updated?.schedule?.expression).toBe('0 * * * *');
    expect(updated?.schedulePaused).toBe(true);
    expect(updated?.nextRunAt).toBe(9999);
    expect(updated?.consecutiveFailures).toBe(2);
    expect(updated?.maxConsecutiveFailures).toBe(5);
  });

  test('updateGoal can clear schedule and nextRunAt (null)', () => {
    const goal = repo.createGoal({
      roomId,
      title: 'G',
      missionType: 'recurring',
      schedule: { expression: '0 * * * *', timezone: 'UTC' },
      nextRunAt: 9999,
    });

    const updated = repo.updateGoal(goal.id, { schedule: null, nextRunAt: null });
    expect(updated?.schedule).toBeUndefined();
    expect(updated?.nextRunAt).toBeUndefined();
  });
});

describe('GoalRepository: mission_metric_history', () => {
  let db: BunDatabase;
  let repo: GoalRepository;
  let goalId: string;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createTables(db);

    const now = Date.now();
    db.exec(
      `INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'R', ${now}, ${now})`
    );
    repo = new GoalRepository(db, noOpReactiveDb);
    const goal = repo.createGoal({ roomId: 'room-1', title: 'Metric Goal' });
    goalId = goal.id;
  });

  test('insertMetricHistory stores a data point', () => {
    const entry = repo.insertMetricHistory(goalId, 'velocity', 42.5, 1000);
    expect(entry.metricName).toBe('velocity');
    expect(entry.value).toBe(42.5);
    expect(entry.recordedAt).toBe(1000);
  });

  test('queryMetricHistory returns entries in ascending order', () => {
    repo.insertMetricHistory(goalId, 'velocity', 10, 1000);
    repo.insertMetricHistory(goalId, 'velocity', 20, 2000);
    repo.insertMetricHistory(goalId, 'velocity', 30, 3000);

    const entries = repo.queryMetricHistory(goalId);
    expect(entries).toHaveLength(3);
    expect(entries[0].value).toBe(10);
    expect(entries[2].value).toBe(30);
  });

  test('queryMetricHistory filters by metricName', () => {
    repo.insertMetricHistory(goalId, 'velocity', 10, 1000);
    repo.insertMetricHistory(goalId, 'coverage', 80, 1000);

    const velocityEntries = repo.queryMetricHistory(goalId, { metricName: 'velocity' });
    expect(velocityEntries).toHaveLength(1);
    expect(velocityEntries[0].metricName).toBe('velocity');
  });

  test('queryMetricHistory filters by time range', () => {
    repo.insertMetricHistory(goalId, 'velocity', 10, 1000);
    repo.insertMetricHistory(goalId, 'velocity', 20, 2000);
    repo.insertMetricHistory(goalId, 'velocity', 30, 3000);

    const entries = repo.queryMetricHistory(goalId, { fromTs: 1500, toTs: 2500 });
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe(20);
  });

  test('queryMetricHistory respects limit', () => {
    for (let i = 0; i < 10; i++) {
      repo.insertMetricHistory(goalId, 'velocity', i, 1000 + i);
    }
    const entries = repo.queryMetricHistory(goalId, { limit: 3 });
    expect(entries).toHaveLength(3);
  });

  test('metric history is cascade deleted when goal is deleted', () => {
    repo.insertMetricHistory(goalId, 'velocity', 42, 1000);
    repo.deleteGoal(goalId);

    const entries = repo.queryMetricHistory(goalId);
    expect(entries).toHaveLength(0);
  });
});

describe('GoalRepository: mission_executions', () => {
  let db: BunDatabase;
  let repo: GoalRepository;
  let goalId: string;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createTables(db);

    const now = Date.now();
    db.exec(
      `INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'R', ${now}, ${now})`
    );
    repo = new GoalRepository(db, noOpReactiveDb);
    const goal = repo.createGoal({ roomId: 'room-1', title: 'Exec Goal' });
    goalId = goal.id;
  });

  test('insertExecution creates a running execution', () => {
    const exec = repo.insertExecution({ goalId, executionNumber: 1 });
    expect(exec.status).toBe('running');
    expect(exec.executionNumber).toBe(1);
    expect(exec.goalId).toBe(goalId);
    expect(exec.taskIds).toEqual([]);
    expect(exec.planningAttempts).toBe(0);
  });

  test('getActiveExecution returns the running execution', () => {
    repo.insertExecution({ goalId, executionNumber: 1 });
    const active = repo.getActiveExecution(goalId);
    expect(active).not.toBeNull();
    expect(active?.executionNumber).toBe(1);
  });

  test('getActiveExecution returns null when no running execution', () => {
    const exec = repo.insertExecution({ goalId, executionNumber: 1 });
    repo.updateExecution(exec.id, { status: 'completed' });
    expect(repo.getActiveExecution(goalId)).toBeNull();
  });

  test('updateExecution updates status and completedAt', () => {
    const exec = repo.insertExecution({ goalId, executionNumber: 1 });
    const updated = repo.updateExecution(exec.id, {
      status: 'completed',
      completedAt: 9999,
      resultSummary: 'Done!',
    });
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).toBe(9999);
    expect(updated?.resultSummary).toBe('Done!');
  });

  test('listExecutions returns most recent first', () => {
    repo.insertExecution({ goalId, executionNumber: 1 });

    const e1 = repo.getActiveExecution(goalId)!;
    repo.updateExecution(e1.id, { status: 'completed' });
    repo.insertExecution({ goalId, executionNumber: 2 });

    const list = repo.listExecutions(goalId);
    expect(list).toHaveLength(2);
    expect(list[0].executionNumber).toBe(2);
    expect(list[1].executionNumber).toBe(1);
  });

  test('listExecutions respects limit', () => {
    for (let i = 1; i <= 5; i++) {
      const exec = repo.insertExecution({ goalId, executionNumber: i });
      if (i < 5) {
        repo.updateExecution(exec.id, { status: 'completed' });
      }
    }
    const limited = repo.listExecutions(goalId, 2);
    expect(limited).toHaveLength(2);
  });

  test('at-most-one running execution is enforced by unique index', () => {
    repo.insertExecution({ goalId, executionNumber: 1 });
    expect(() => {
      repo.insertExecution({ goalId, executionNumber: 2 });
    }).toThrow();
  });

  test('updateExecution increments planningAttempts', () => {
    const exec = repo.insertExecution({ goalId, executionNumber: 1 });
    const updated = repo.updateExecution(exec.id, { planningAttempts: 3 });
    expect(updated?.planningAttempts).toBe(3);
  });
});

describe('getEffectiveMaxPlanningAttempts', () => {
  function makeGoal(
    maxPlanningAttempts?: number
  ): Parameters<typeof getEffectiveMaxPlanningAttempts>[0] {
    return {
      id: 'g-1',
      roomId: 'r-1',
      title: 'T',
      description: '',
      status: 'active',
      priority: 'normal',
      progress: 0,
      linkedTaskIds: [],
      createdAt: 0,
      updatedAt: 0,
      maxPlanningAttempts,
    };
  }

  test('returns goal-level override when set', () => {
    const goal = makeGoal(7);
    expect(getEffectiveMaxPlanningAttempts(goal, { maxPlanningRetries: 5 })).toBe(7);
  });

  test('falls back to roomConfig.maxPlanningRetries + 1', () => {
    const goal = makeGoal(undefined);
    expect(getEffectiveMaxPlanningAttempts(goal, { maxPlanningRetries: 2 })).toBe(3);
  });

  test('roomConfig.maxPlanningRetries = 0 means 1 total attempt', () => {
    const goal = makeGoal(undefined);
    expect(getEffectiveMaxPlanningAttempts(goal, { maxPlanningRetries: 0 })).toBe(1);
  });

  test('returns 2 when neither goal nor roomConfig specifies (default allows 1 retry)', () => {
    const goal = makeGoal(undefined);
    expect(getEffectiveMaxPlanningAttempts(goal)).toBe(2);
  });

  test('returns 2 when roomConfig has no maxPlanningRetries', () => {
    const goal = makeGoal(undefined);
    expect(getEffectiveMaxPlanningAttempts(goal, { someOtherKey: 99 })).toBe(2);
  });

  test('ignores goal.maxPlanningAttempts of 0 (falls through to roomConfig)', () => {
    const goal = makeGoal(0);
    expect(getEffectiveMaxPlanningAttempts(goal, { maxPlanningRetries: 4 })).toBe(5);
  });
});
