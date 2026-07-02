/**
 * SkillRepository
 *
 * CRUD operations for the application-level Skills registry.
 * Each write method calls reactiveDb.notifyChange('skills') so that
 * LiveQueryEngine can invalidate frontend subscriptions on every registry change.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type {
  AppSkill,
  AppSkillConfig,
  SkillSourceType,
  SkillValidationStatus,
  UpdateSkillParams,
} from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database';

// ---------------------------------------------------------------------------
// Internal row type (mirrors SQLite columns)
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  source_type: string;
  config: string;
  enabled: number;
  built_in: number;
  validation_status: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSkill(row: SkillRow): AppSkill {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    sourceType: row.source_type as SkillSourceType,
    config: JSON.parse(row.config) as AppSkillConfig,
    enabled: row.enabled === 1,
    builtIn: row.built_in === 1,
    validationStatus: row.validation_status as SkillValidationStatus,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SkillRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {}

  /**
   * List all skills, ordered by created_at ascending.
   */
  findAll(): AppSkill[] {
    const rows = this.db
      .prepare(`SELECT * FROM skills ORDER BY created_at ASC`)
      .all() as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * Get a skill by ID. Returns null if not found.
   */
  get(id: string): AppSkill | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as
      | SkillRow
      | undefined;
    return row ? rowToSkill(row) : null;
  }

  /**
   * Get a skill by name. Returns null if not found.
   */
  getByName(name: string): AppSkill | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE name = ?`).get(name) as
      | SkillRow
      | undefined;
    return row ? rowToSkill(row) : null;
  }

  /**
   * List only enabled skills, ordered by created_at ascending.
   */
  findEnabled(): AppSkill[] {
    const rows = this.db
      .prepare(`SELECT * FROM skills WHERE enabled = 1 ORDER BY created_at ASC`)
      .all() as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * Insert a new skill record.
   */
  insert(skill: AppSkill): void {
    this.db
      .prepare(
        `INSERT INTO skills
         (id, name, display_name, description, source_type, config, enabled, built_in, validation_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
    this.reactiveDb.notifyChange('skills');
  }

  /**
   * Update user-editable fields on an existing skill (mirrors UpdateSkillParams).
   * Immutable fields (name, sourceType, builtIn, createdAt) are not settable here.
   */
  update(id: string, fields: UpdateSkillParams): void {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    if (fields.displayName !== undefined) {
      setClauses.push('display_name = ?');
      values.push(fields.displayName);
    }
    if (fields.description !== undefined) {
      setClauses.push('description = ?');
      values.push(fields.description);
    }
    if (fields.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(fields.enabled ? 1 : 0);
    }
    if (fields.config !== undefined) {
      setClauses.push('config = ?');
      values.push(JSON.stringify(fields.config));
    }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE skills SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    this.reactiveDb.notifyChange('skills');
  }

  /**
   * Toggle the enabled flag for a skill. Targeted single-column UPDATE.
   */
  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE skills SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    this.reactiveDb.notifyChange('skills');
  }

  /**
   * Set the validation_status for a skill. Used by the async validation job.
   * Only fires notifyChange when a row was actually updated.
   */
  setValidationStatus(id: string, status: SkillValidationStatus): boolean {
    const result = this.db
      .prepare(`UPDATE skills SET validation_status = ? WHERE id = ?`)
      .run(status, id);
    const changed = result.changes > 0;
    if (changed) {
      this.reactiveDb.notifyChange('skills');
    }
    return changed;
  }

  /**
   * Delete a skill by ID. Returns true if a row was deleted.
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM skills WHERE id = ?`).run(id);
    const deleted = result.changes > 0;
    if (deleted) {
      this.reactiveDb.notifyChange('skills');
    }
    return deleted;
  }
}
