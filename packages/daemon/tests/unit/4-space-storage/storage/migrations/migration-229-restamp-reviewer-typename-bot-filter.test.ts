import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { REVIEWER_SYSTEM_CONTRACT } from '../../../../../src/lib/space/agents/system-contracts.ts';
import {
  runMigration229,
  STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256,
  STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION,
  STALE_PRE_TYPENAME_REVIEWER_TOOLS,
} from '../../../../../src/storage/schema/m229-restamp-reviewer-typename-bot-filter.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { RETIRED_PRE_TYPENAME_REVIEWER_CONTRACT } from './fixtures/retired-pre-typename-reviewer-contract.ts';

interface AgentRow {
  id: string;
  instructions: string | null;
}

const STALE_CONTRACT = RETIRED_PRE_TYPENAME_REVIEWER_CONTRACT;

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE space_long_horizon_agents (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT,
    template_key TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    session_id TEXT,
    instructions TEXT NOT NULL DEFAULT '',
    autonomy_level INTEGER,
    model TEXT,
    thinking_level TEXT,
    provider TEXT,
    setting_sources TEXT,
    tool_permissions_json TEXT,
    description TEXT,
    model_pool TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return db;
}

function insertAgent(
  db: BunDatabase,
  opts: {
    id: string;
    handle: string;
    displayName?: string;
    templateKey?: string | null;
    instructions: string;
    description?: string | null;
    tools?: string[];
    status?: string;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, session_id,
       instructions, autonomy_level, model, thinking_level, provider, setting_sources,
       tool_permissions_json, description, model_pool, created_at, updated_at
     ) VALUES (?, 'space-1', ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?)`
  ).run(
    opts.id,
    opts.handle,
    opts.displayName ?? opts.handle,
    opts.templateKey ?? null,
    opts.status ?? 'active',
    opts.instructions,
    JSON.stringify({ tools: opts.tools ?? [...STALE_PRE_TYPENAME_REVIEWER_TOOLS] }),
    opts.description === undefined
      ? (STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION ?? null)
      : opts.description,
    now,
    now
  );
}

function getInstructions(db: BunDatabase, id: string): string | null {
  const row = db
    .prepare(`SELECT instructions FROM space_long_horizon_agents WHERE id = ?`)
    .get(id) as AgentRow | undefined;
  return row?.instructions ?? null;
}

describe('migration 229: re-stamp reviewer presets with the __typename bot filter', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  test('the frozen stale contract matches the pinned hash and predates the fix', () => {
    expect(createHash('sha256').update(STALE_CONTRACT).digest('hex')).toBe(
      STALE_PRE_TYPENAME_REVIEWER_CONTRACT_SHA256
    );
    expect(STALE_CONTRACT).not.toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(STALE_CONTRACT).toContain('a login ending in `[bot]`');
    expect(REVIEWER_SYSTEM_CONTRACT).toContain('filter GraphQL results on `__typename == "Bot"`');
  });

  test('re-stamps pristine seeded and template-created reviewer rows, leaves the rest untouched', () => {
    insertAgent(db, {
      id: 'seeded-pristine',
      handle: 'reviewer',
      displayName: 'Reviewer',
      instructions: STALE_CONTRACT,
    });
    insertAgent(db, {
      id: 'template-pristine',
      handle: 'my-reviewer-2',
      displayName: 'My Reviewer',
      templateKey: 'Reviewer',
      instructions: STALE_CONTRACT,
      description: null,
    });
    insertAgent(db, {
      id: 'customized-instructions',
      handle: 'reviewer-3',
      displayName: 'Reviewer',
      instructions: `${STALE_CONTRACT}\nextra standing instruction`,
    });
    insertAgent(db, {
      id: 'customized-description',
      handle: 'reviewer-4',
      displayName: 'Reviewer',
      instructions: STALE_CONTRACT,
      description: 'my own reviewer',
    });
    insertAgent(db, {
      id: 'archived-pristine',
      handle: 'reviewer-5',
      displayName: 'Reviewer',
      instructions: STALE_CONTRACT,
      status: 'archived',
    });
    insertAgent(db, {
      id: 'other-agent',
      handle: 'general',
      displayName: 'General',
      instructions: STALE_CONTRACT,
    });

    runMigration229(db);

    expect(getInstructions(db, 'seeded-pristine')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(getInstructions(db, 'template-pristine')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(getInstructions(db, 'customized-instructions')).toBe(
      `${STALE_CONTRACT}\nextra standing instruction`
    );
    expect(getInstructions(db, 'customized-description')).toBe(STALE_CONTRACT);
    expect(getInstructions(db, 'archived-pristine')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(getInstructions(db, 'other-agent')).toBe(STALE_CONTRACT);
  });

  test('is a no-op on databases without the unified agent table', () => {
    const empty = new BunDatabase(':memory:');
    expect(() => runMigration229(empty)).not.toThrow();
  });
});
