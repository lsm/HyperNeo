import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  RoomGitHubMapping,
  RepositoryMapping,
  CreateRoomGitHubMappingParams,
  UpdateRoomGitHubMappingParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types';

export class GitHubMappingRepository {
  constructor(private db: BunDatabase) {}

  createMapping(params: CreateRoomGitHubMappingParams): RoomGitHubMapping {
    const id = generateUUID();
    const now = Date.now();

    const stmt = this.db.prepare(
      `INSERT INTO room_github_mappings (id, room_id, repositories, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.roomId,
      JSON.stringify(params.repositories),
      params.priority ?? 0,
      now,
      now
    );

    return this.getMapping(id)!;
  }

  getMapping(id: string): RoomGitHubMapping | null {
    const stmt = this.db.prepare(`SELECT * FROM room_github_mappings WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToMapping(row);
  }

  getMappingByRoomId(roomId: string): RoomGitHubMapping | null {
    const stmt = this.db.prepare(`SELECT * FROM room_github_mappings WHERE room_id = ?`);
    const row = stmt.get(roomId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToMapping(row);
  }

  listMappings(): RoomGitHubMapping[] {
    const stmt = this.db.prepare(
      `SELECT * FROM room_github_mappings ORDER BY priority DESC, created_at ASC`
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMapping(r));
  }

  listMappingsForRepository(owner: string, repo: string): RoomGitHubMapping[] {
    const stmt = this.db.prepare(`SELECT * FROM room_github_mappings ORDER BY priority DESC`);
    const rows = stmt.all() as Record<string, unknown>[];
    const mappings = rows.map((r) => this.rowToMapping(r));

    return mappings.filter((m) =>
      m.repositories.some((rm: RepositoryMapping) => rm.owner === owner && rm.repo === repo)
    );
  }

  updateMapping(id: string, params: UpdateRoomGitHubMappingParams): RoomGitHubMapping | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.repositories !== undefined) {
      fields.push('repositories = ?');
      values.push(JSON.stringify(params.repositories));
    }
    if (params.priority !== undefined) {
      fields.push('priority = ?');
      values.push(params.priority);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      const stmt = this.db.prepare(
        `UPDATE room_github_mappings SET ${fields.join(', ')} WHERE id = ?`
      );
      stmt.run(...values);
    }

    return this.getMapping(id);
  }

  deleteMapping(id: string): void {
    const stmt = this.db.prepare(`DELETE FROM room_github_mappings WHERE id = ?`);
    stmt.run(id);
  }

  deleteMappingByRoomId(roomId: string): void {
    const stmt = this.db.prepare(`DELETE FROM room_github_mappings WHERE room_id = ?`);
    stmt.run(roomId);
  }

  private rowToMapping(row: Record<string, unknown>): RoomGitHubMapping {
    return {
      id: row.id as string,
      roomId: row.room_id as string,
      repositories: JSON.parse(row.repositories as string) as RepositoryMapping[],
      priority: row.priority as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
