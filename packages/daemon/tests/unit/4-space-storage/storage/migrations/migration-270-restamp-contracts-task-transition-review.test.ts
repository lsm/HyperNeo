import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { getPresetAgentTemplates } from '../../../../../src/lib/agents/seed-agents.ts';
import {
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
} from '../../../../../src/lib/agents/system-contracts.ts';
import {
  PRE_TRANSITION_REVIEW_CONTRACT_SHA256,
  runMigration270,
} from '../../../../../src/storage/schema/m270-restamp-contracts-task-transition-review.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

const RETIRED_NAME = 'task.submitForReview';

const SUBMIT_FOR_REVIEW_WORDING: [current: string, retired: string][] = [
  [
    '`task.approve` or a `task.transition` to `review`, and again',
    '`task.approve`/`task.submitForReview`, and again',
  ],
  [
    '`task.approve` and a `task.transition` to `review` are',
    '`task.approve` and `task.submitForReview` are',
  ],
  [
    'follow the task.approve and task.transition tool descriptions',
    'follow task.approve/task.submitForReview tool descriptions',
  ],
  ['If the task.transition to review fails', 'If task.submitForReview fails'],
];

function retire(contract: string): string {
  return SUBMIT_FOR_REVIEW_WORDING.reduce(
    (text, [current, retired]) => text.replace(current, retired),
    contract
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE space_long_horizon_agents (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT,
    template_key TEXT,
    instructions TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE space_agent_templates (
    key TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return db;
}

function insertAgent(db: BunDatabase, id: string, handle: string, instructions: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, template_key, instructions, created_at, updated_at)
     VALUES (?, 'space-1', ?, ?, NULL, ?, ?, ?)`
  ).run(id, handle, handle, instructions, now, now);
}

function instructionsOf(db: BunDatabase, id: string): string {
  const row = db
    .prepare(`SELECT instructions FROM space_long_horizon_agents WHERE id = ?`)
    .get(id) as { instructions: string };
  return row.instructions;
}

describe('migration 270 — restamp agent contracts naming task.submitForReview', () => {
  let db: BunDatabase;
  beforeEach(() => {
    db = makeDb();
  });

  test('the recorded hashes include the current contracts with the retired operation name', () => {
    expect(PRE_TRANSITION_REVIEW_CONTRACT_SHA256.Reviewer).toContain(
      sha256(retire(REVIEWER_SYSTEM_CONTRACT))
    );
    expect(PRE_TRANSITION_REVIEW_CONTRACT_SHA256.QA).toContain(sha256(retire(QA_SYSTEM_CONTRACT)));
  });

  test('restamps a Reviewer and a QA agent carrying the retired contract', () => {
    insertAgent(db, 'agent-reviewer', 'reviewer', retire(REVIEWER_SYSTEM_CONTRACT));
    insertAgent(db, 'agent-qa', 'qa', retire(QA_SYSTEM_CONTRACT));
    expect(instructionsOf(db, 'agent-reviewer')).toContain(RETIRED_NAME);

    runMigration270(db);

    expect(instructionsOf(db, 'agent-reviewer')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(instructionsOf(db, 'agent-qa')).toBe(QA_SYSTEM_CONTRACT);
    expect(instructionsOf(db, 'agent-reviewer')).not.toContain(RETIRED_NAME);
  });

  test('leaves an edited contract alone', () => {
    const edited = `${retire(REVIEWER_SYSTEM_CONTRACT)}\n\nOperator addendum.`;
    insertAgent(db, 'agent-edited', 'reviewer', edited);

    runMigration270(db);

    expect(instructionsOf(db, 'agent-edited')).toBe(edited);
  });

  test('is idempotent and leaves an already-current contract untouched', () => {
    insertAgent(db, 'agent-current', 'reviewer', REVIEWER_SYSTEM_CONTRACT);
    insertAgent(db, 'agent-stale', 'qa', retire(QA_SYSTEM_CONTRACT));

    runMigration270(db);
    runMigration270(db);

    expect(instructionsOf(db, 'agent-current')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(instructionsOf(db, 'agent-stale')).toBe(QA_SYSTEM_CONTRACT);
  });

  test('restamps a synthesized template carrying the retired contract', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_agent_templates (key, handle, display_name, instructions, version, created_at, updated_at)
       VALUES (?, 'reviewer', 'Reviewer', ?, 1, ?, ?)`
    ).run('migrated.agent.agent-1', retire(REVIEWER_SYSTEM_CONTRACT), now, now);

    runMigration270(db);

    const row = db
      .prepare(`SELECT instructions FROM space_agent_templates WHERE key = ?`)
      .get('migrated.agent.agent-1') as { instructions: string };
    expect(row.instructions).toBe(REVIEWER_SYSTEM_CONTRACT);
  });

  test('runs without a space_long_horizon_agents table', () => {
    const bare = new BunDatabase(':memory:');
    expect(() => runMigration270(bare)).not.toThrow();
  });

  test('every preset the migration names still exists', () => {
    const names = getPresetAgentTemplates().map((preset) => preset.name);
    for (const presetName of Object.keys(PRE_TRANSITION_REVIEW_CONTRACT_SHA256)) {
      expect(names, presetName).toContain(presetName);
    }
  });
});
