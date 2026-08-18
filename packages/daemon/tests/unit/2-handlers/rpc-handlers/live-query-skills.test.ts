import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';
import { SkillRepository } from '../../../../src/storage/repositories/skill-repository';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { AppSkill } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
  return db;
}

function makeSkill(overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id: `skill-${Math.random().toString(36).slice(2)}`,
    name: 'test-skill',
    displayName: 'Test Skill',
    description: 'A test skill',
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: 'test-cmd' },
    enabled: true,
    builtIn: false,
    validationStatus: 'pending',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('skills.list named query', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  function queryAndMap(): Record<string, unknown>[] {
    const entry = NAMED_QUERY_REGISTRY.get('skills.list')!;
    const rows = db.prepare(entry.sql).all() as Record<string, unknown>[];
    return entry.mapRow ? rows.map(entry.mapRow) : rows;
  }

  function insertSkillRow(skill: AppSkill): void {
    db.prepare(
      `INSERT INTO skills
			 (id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      skill.id,
      skill.name,
      skill.displayName,
      skill.description,
      skill.sourceType,
      JSON.stringify(skill.config),
      skill.enabled ? 1 : 0,
      skill.builtIn ? 1 : 0,
      skill.validationStatus,
      skill.createdAt
    );
  }

  test('registry contains skills.list entry', () => {
    expect(NAMED_QUERY_REGISTRY.has('skills.list')).toBe(true);
  });

  test('skills.list has paramCount 0', () => {
    expect(NAMED_QUERY_REGISTRY.get('skills.list')!.paramCount).toBe(0);
  });

  test('returns empty array on fresh DB', () => {
    expect(queryAndMap()).toEqual([]);
  });

  test('returns correct camelCase aliases', () => {
    insertSkillRow(makeSkill({ id: 's1', name: 'skill-a', createdAt: 1 }));
    const [row] = queryAndMap();
    expect(row).toHaveProperty('displayName');
    expect(row).not.toHaveProperty('display_name');
    expect(row).toHaveProperty('sourceType');
    expect(row).not.toHaveProperty('source_type');
    expect(row).toHaveProperty('builtIn');
    expect(row).not.toHaveProperty('built_in');
    expect(row).toHaveProperty('validationStatus');
    expect(row).not.toHaveProperty('validation_status');
    expect(row).toHaveProperty('createdAt');
    expect(row).not.toHaveProperty('created_at');
  });

  test('coerces enabled integer to boolean true', () => {
    insertSkillRow(makeSkill({ id: 's2', name: 'skill-b', enabled: true, createdAt: 1 }));
    const [row] = queryAndMap();
    expect(row.enabled).toBe(true);
  });

  test('coerces enabled integer to boolean false', () => {
    insertSkillRow(makeSkill({ id: 's3', name: 'skill-c', enabled: false, createdAt: 1 }));
    const [row] = queryAndMap();
    expect(row.enabled).toBe(false);
  });

  test('coerces builtIn integer to boolean', () => {
    insertSkillRow(makeSkill({ id: 's4', name: 'skill-d', builtIn: true, createdAt: 1 }));
    const [row] = queryAndMap();
    expect(row.builtIn).toBe(true);
  });

  test('parses config JSON blob', () => {
    const config = { type: 'builtin', commandName: 'my-cmd' };
    insertSkillRow(makeSkill({ id: 's5', name: 'skill-e', config, createdAt: 1 }));
    const [row] = queryAndMap();
    expect(row.config).toEqual(config);
  });

  test('ORDER BY is built_in DESC, created_at ASC, id ASC — built-in skills first', () => {
    const now = Date.now();
    insertSkillRow(makeSkill({ id: 'user-1', name: 'user-skill', builtIn: false, createdAt: now }));
    insertSkillRow(
      makeSkill({ id: 'bi-1', name: 'builtin-skill', builtIn: true, createdAt: now + 1 })
    );
    const rows = queryAndMap();
    expect(rows).toHaveLength(2);
    expect(rows[0].builtIn).toBe(true);
    expect(rows[1].builtIn).toBe(false);
  });

  test('ORDER BY created_at ASC within same builtIn value', () => {
    insertSkillRow(makeSkill({ id: 'a', name: 'skill-late', builtIn: false, createdAt: 200 }));
    insertSkillRow(makeSkill({ id: 'b', name: 'skill-early', builtIn: false, createdAt: 100 }));
    const rows = queryAndMap();
    expect(rows[0].id).toBe('b');
    expect(rows[1].id).toBe('a');
  });

  test('row contains all expected fields', () => {
    const skill = makeSkill({ id: 's6', name: 'full-skill', createdAt: 1 });
    insertSkillRow(skill);
    const [row] = queryAndMap();
    expect(row).toHaveProperty('id', 's6');
    expect(row).toHaveProperty('name', 'full-skill');
    expect(row).toHaveProperty('displayName');
    expect(row).toHaveProperty('description');
    expect(row).toHaveProperty('sourceType');
    expect(row).toHaveProperty('config');
    expect(row).toHaveProperty('enabled');
    expect(row).toHaveProperty('builtIn');
    expect(row).toHaveProperty('validationStatus');
    expect(row).toHaveProperty('createdAt');
  });
});

describe('SkillRepository reactive notifications', () => {
  let db: BunDatabase;
  let notifyCalls: string[];
  let reactiveDb: ReactiveDatabase;

  beforeEach(() => {
    db = makeDb();
    notifyCalls = [];
    reactiveDb = {
      notifyChange: (table: string) => {
        notifyCalls.push(table);
      },
      on: () => {},
      off: () => {},
      getTableVersion: () => 0,
      beginTransaction: () => {},
      commitTransaction: () => {},
      abortTransaction: () => {},
      db: null as never,
    };
  });

  afterEach(() => {
    db.close();
  });

  function makeRepo(): SkillRepository {
    return new SkillRepository(db, reactiveDb);
  }

  test('insert calls notifyChange("skills")', () => {
    const repo = makeRepo();
    repo.insert(makeSkill({ id: 'n1', name: 'skill-n1' }));
    expect(notifyCalls).toContain('skills');
  });

  test('update calls notifyChange("skills") when fields provided', () => {
    const repo = makeRepo();
    repo.insert(makeSkill({ id: 'n2', name: 'skill-n2' }));
    notifyCalls = [];
    repo.update('n2', { displayName: 'Updated' });
    expect(notifyCalls).toContain('skills');
  });

  test('update does NOT call notifyChange when no fields provided', () => {
    const repo = makeRepo();
    repo.insert(makeSkill({ id: 'n3', name: 'skill-n3' }));
    notifyCalls = [];
    repo.update('n3', {});
    expect(notifyCalls).not.toContain('skills');
  });

  test('delete calls notifyChange("skills") when row was deleted', () => {
    const repo = makeRepo();
    repo.insert(makeSkill({ id: 'n4', name: 'skill-n4' }));
    notifyCalls = [];
    repo.delete('n4');
    expect(notifyCalls).toContain('skills');
  });

  test('delete does NOT call notifyChange when row not found', () => {
    const repo = makeRepo();
    notifyCalls = [];
    repo.delete('nonexistent');
    expect(notifyCalls).not.toContain('skills');
  });

  test('setEnabled calls notifyChange("skills")', () => {
    const repo = makeRepo();
    repo.insert(makeSkill({ id: 'n5', name: 'skill-n5' }));
    notifyCalls = [];
    repo.setEnabled('n5', false);
    expect(notifyCalls).toContain('skills');
  });

  test('setValidationStatus calls notifyChange("skills") when row updated', () => {
    const repo = makeRepo();
    repo.insert(makeSkill({ id: 'n6', name: 'skill-n6' }));
    notifyCalls = [];
    const changed = repo.setValidationStatus('n6', 'valid');
    expect(changed).toBe(true);
    expect(notifyCalls).toContain('skills');
  });

  test('setValidationStatus does NOT call notifyChange when row not found', () => {
    const repo = makeRepo();
    notifyCalls = [];
    const changed = repo.setValidationStatus('nonexistent', 'valid');
    expect(changed).toBe(false);
    expect(notifyCalls).not.toContain('skills');
  });
});
