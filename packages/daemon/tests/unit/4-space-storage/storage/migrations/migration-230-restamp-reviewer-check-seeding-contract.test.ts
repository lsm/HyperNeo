import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING,
} from '@hyperneo/prompts';
import { REVIEWER_SYSTEM_CONTRACT } from '../../../../../src/lib/space/agents/system-contracts.ts';
import {
  PRE_CHECK_SEEDING_REVIEWER_CONTRACT_SHA256,
  runMigration230,
} from '../../../../../src/storage/schema/m230-restamp-reviewer-check-seeding-contract.ts';
import {
  STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION,
  STALE_PRE_TYPENAME_REVIEWER_TOOLS,
} from '../../../../../src/storage/schema/m229-restamp-reviewer-typename-bot-filter.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { RETIRED_PRE_TYPENAME_REVIEWER_CONTRACT } from './fixtures/retired-pre-typename-reviewer-contract.ts';

const STALE_CONTRACT = RETIRED_PRE_TYPENAME_REVIEWER_CONTRACT;
const PRE_CHECK_SEEDING_CONTRACT = REVIEWER_SYSTEM_CONTRACT.replace(
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING
);

interface Row {
  instructions: string | null;
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
    tool_permissions_json TEXT,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE space_agent_templates (
    key TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    suggested_autonomy_level INTEGER NOT NULL DEFAULT 2,
    tools TEXT DEFAULT NULL,
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
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key,
       instructions, tool_permissions_json, description, created_at, updated_at
     ) VALUES (?, 'space-1', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.handle,
    opts.displayName ?? opts.handle,
    opts.templateKey ?? null,
    opts.instructions,
    JSON.stringify({ tools: [...STALE_PRE_TYPENAME_REVIEWER_TOOLS] }),
    opts.description === undefined
      ? (STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION ?? null)
      : opts.description,
    now,
    now
  );
}

function insertTemplate(
  db: BunDatabase,
  opts: { key: string; instructions: string; description?: string; tools?: string[] | null }
): void {
  const now = Date.now();
  const toolsJson =
    opts.tools === undefined
      ? JSON.stringify([...STALE_PRE_TYPENAME_REVIEWER_TOOLS])
      : opts.tools === null
        ? null
        : JSON.stringify(opts.tools);
  db.prepare(
    `INSERT INTO space_agent_templates (
       key, handle, display_name, description, instructions,
       suggested_autonomy_level, tools, created_at, updated_at
     ) VALUES (?, 'reviewer', 'Reviewer', ?, ?, 2, ?, ?, ?)`
  ).run(
    opts.key,
    opts.description ?? STALE_PRE_TYPENAME_REVIEWER_DESCRIPTION,
    opts.instructions,
    toolsJson,
    now,
    now
  );
}

function getInstructions(db: BunDatabase, id: string): string | null {
  const row = db
    .prepare(`SELECT instructions FROM space_long_horizon_agents WHERE id = ?`)
    .get(id) as Row | undefined;
  return row?.instructions ?? null;
}

function getTemplateInstructions(db: BunDatabase, key: string): string | null {
  const row = db.prepare(`SELECT instructions FROM space_agent_templates WHERE key = ?`).get(key) as
    | Row
    | undefined;
  return row?.instructions ?? null;
}

describe('migration 230: re-stamp reviewer presets with the check-seeding contract', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  test('the frozen pre-check-seeding contract matches the pinned hash and predates the fix', () => {
    expect(createHash('sha256').update(PRE_CHECK_SEEDING_CONTRACT).digest('hex')).toBe(
      PRE_CHECK_SEEDING_REVIEWER_CONTRACT_SHA256
    );
    expect(PRE_CHECK_SEEDING_CONTRACT).not.toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(PRE_CHECK_SEEDING_CONTRACT).toContain(
      '(b) it appears as a review-app check in `gh pr checks`'
    );
    expect(REVIEWER_SYSTEM_CONTRACT).toContain('a recognized review-app check is INDEPENDENT');
  });

  test('re-stamps pristine reviewer rows holding the pre-check-seeding contract', () => {
    insertAgent(db, {
      id: 'seeded-pristine',
      handle: 'reviewer',
      displayName: 'Reviewer',
      instructions: PRE_CHECK_SEEDING_CONTRACT,
    });
    insertAgent(db, {
      id: 'seeded-cleared-description',
      handle: 'reviewer-2',
      displayName: 'Reviewer',
      instructions: PRE_CHECK_SEEDING_CONTRACT,
      description: null,
    });
    insertAgent(db, {
      id: 'template-pristine',
      handle: 'my-reviewer-3',
      displayName: 'My Reviewer',
      templateKey: 'Reviewer',
      instructions: PRE_CHECK_SEEDING_CONTRACT,
      description: null,
    });
    insertAgent(db, {
      id: 'customized-instructions',
      handle: 'reviewer-4',
      displayName: 'Reviewer',
      instructions: `${PRE_CHECK_SEEDING_CONTRACT}\nextra standing instruction`,
    });
    insertAgent(db, {
      id: 'pre-typename-stale',
      handle: 'reviewer-5',
      displayName: 'Reviewer',
      instructions: STALE_CONTRACT,
    });

    runMigration230(db);

    expect(getInstructions(db, 'seeded-pristine')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(getInstructions(db, 'seeded-cleared-description')).toBe(PRE_CHECK_SEEDING_CONTRACT);
    expect(getInstructions(db, 'template-pristine')).toBe(REVIEWER_SYSTEM_CONTRACT);
    expect(getInstructions(db, 'customized-instructions')).toBe(
      `${PRE_CHECK_SEEDING_CONTRACT}\nextra standing instruction`
    );
    expect(getInstructions(db, 'pre-typename-stale')).toBe(STALE_CONTRACT);
  });

  test('re-stamps pristine synthesized reviewer templates, leaves the rest untouched', () => {
    insertTemplate(db, { key: 'migrated.agent.agent-seeded', instructions: STALE_CONTRACT });
    insertTemplate(db, {
      key: 'migrated.agent.agent-template-created',
      instructions: STALE_CONTRACT,
      description: '',
    });
    insertTemplate(db, {
      key: 'migrated.agent.agent-customized',
      instructions: STALE_CONTRACT,
      description: 'my own reviewer',
    });
    insertTemplate(db, { key: 'user.template.reviewer', instructions: STALE_CONTRACT });
    insertTemplate(db, {
      key: 'migrated.agent.agent-wrong-tools',
      instructions: STALE_CONTRACT,
      tools: ['Read'],
    });

    runMigration230(db);

    expect(getTemplateInstructions(db, 'migrated.agent.agent-seeded')).toBe(
      REVIEWER_SYSTEM_CONTRACT
    );
    expect(getTemplateInstructions(db, 'migrated.agent.agent-template-created')).toBe(
      REVIEWER_SYSTEM_CONTRACT
    );
    expect(getTemplateInstructions(db, 'migrated.agent.agent-customized')).toBe(STALE_CONTRACT);
    expect(getTemplateInstructions(db, 'user.template.reviewer')).toBe(STALE_CONTRACT);
    expect(getTemplateInstructions(db, 'migrated.agent.agent-wrong-tools')).toBe(STALE_CONTRACT);
  });

  test('is a no-op on databases without the agent tables', () => {
    const empty = new BunDatabase(':memory:');
    expect(() => runMigration230(empty)).not.toThrow();
  });
});
