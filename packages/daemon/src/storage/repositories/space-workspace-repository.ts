import { generateUUID } from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';

export interface SpaceWorkspaceRecord {
  id: string;
  spaceId: string;
  path: string;
  label: string;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
}

export class SpaceWorkspaceRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  create(params: {
    spaceId: string;
    path: string;
    label?: string;
    isPrimary?: boolean;
  }): SpaceWorkspaceRecord {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_workspaces (id, space_id, path, label, is_primary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, params.spaceId, params.path, params.label ?? '', params.isPrimary ? 1 : 0, now, now);
    this.reactiveDb?.notifyChange('space_workspaces', { spaceId: params.spaceId });
    return this.getById(id)!;
  }

  createUnclaimed(params: {
    spaceId: string;
    path: string;
    label?: string;
    isPrimary?: boolean;
  }): SpaceWorkspaceRecord | null {
    const id = generateUUID();
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO space_workspaces (id, space_id, path, label, is_primary, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM space_workspaces WHERE path = ?)`
      )
      .run(
        id,
        params.spaceId,
        params.path,
        params.label ?? '',
        params.isPrimary ? 1 : 0,
        now,
        now,
        params.path
      );
    if (result.changes === 0) return null;
    return this.getById(id)!;
  }

  getById(id: string): SpaceWorkspaceRecord | null {
    const row = this.db.prepare(`SELECT * FROM space_workspaces WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  listBySpace(spaceId: string): SpaceWorkspaceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_workspaces WHERE space_id = ? ORDER BY is_primary DESC, created_at ASC, id ASC`
      )
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  getByPath(spaceId: string, path: string): SpaceWorkspaceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM space_workspaces WHERE space_id = ? AND path = ?`)
      .get(spaceId, path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  findOwnerByPath(path: string): SpaceWorkspaceRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_workspaces WHERE path = ? ORDER BY is_primary DESC, created_at ASC, id ASC LIMIT 1`
      )
      .get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  updateLabel(spaceId: string, workspaceId: string, label: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_workspaces SET label = ?, updated_at = ? WHERE space_id = ? AND id = ?`
      )
      .run(label, Date.now(), spaceId, workspaceId);
    if (result.changes > 0) this.reactiveDb?.notifyChange('space_workspaces', { spaceId });
    return result.changes > 0;
  }

  delete(spaceId: string, workspaceId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM space_workspaces WHERE space_id = ? AND id = ?`)
      .run(spaceId, workspaceId);
    if (result.changes > 0) this.reactiveDb?.notifyChange('space_workspaces', { spaceId });
    return result.changes > 0;
  }

  countBySpace(spaceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM space_workspaces WHERE space_id = ?`)
      .get(spaceId) as { c: number };
    return row.c;
  }

  private rowToRecord(row: Record<string, unknown>): SpaceWorkspaceRecord {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      path: row.path as string,
      label: row.label as string,
      isPrimary: row.is_primary === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
