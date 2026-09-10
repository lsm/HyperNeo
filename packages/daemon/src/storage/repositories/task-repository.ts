import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  NeoTask,
  TaskFilter,
  CreateTaskParams,
  TaskRestriction,
} from '@hyperneo/shared/types/neo';
import type { SQLiteValue } from '../types.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { ShortIdAllocator } from '../../lib/short-id-allocator.ts';

export class TaskRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase,
    private shortIdAllocator?: ShortIdAllocator
  ) {}

  createTask(params: CreateTaskParams): NeoTask {
    const id = generateUUID();
    const now = Date.now();
    const shortId = this.shortIdAllocator?.allocate('task', params.roomId) ?? null;

    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, room_id, title, description, status, priority, depends_on, task_type, assigned_agent, created_by_task_id, short_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.roomId,
      params.title,
      params.description,
      params.status ?? 'pending',
      params.priority ?? 'normal',
      JSON.stringify(params.dependsOn ?? []),
      params.taskType ?? 'coding',
      params.assignedAgent ?? 'coder',
      params.createdByTaskId ?? null,
      shortId,
      now,
      now
    );

    this.reactiveDb.notifyChange('tasks');
    return this.getTaskDirect(id)!;
  }

  private getTaskDirect(id: string): NeoTask | null {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  getTask(id: string): NeoTask | null {
    const task = this.getTaskDirect(id);
    if (!task) return null;
    if (!task.shortId && this.shortIdAllocator) {
      const shortId = this.shortIdAllocator.allocate('task', task.roomId);
      this.db.prepare(`UPDATE tasks SET short_id = ? WHERE id = ?`).run(shortId, id);
      return { ...task, shortId };
    }
    return task;
  }

  getTaskByShortId(roomId: string, shortId: string): NeoTask | null {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE room_id = ? AND short_id = ?`);
    const row = stmt.get(roomId, shortId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  listTasks(roomId?: string | null, filter?: TaskFilter): NeoTask[] {
    let query = `SELECT * FROM tasks`;
    const params: SQLiteValue[] = [];
    let hasWhere = false;

    if (roomId) {
      query += ` WHERE room_id = ?`;
      params.push(roomId);
      hasWhere = true;
    }

    if (!filter?.includeArchived) {
      query += hasWhere ? ` AND status != 'archived'` : ` WHERE status != 'archived'`;
      hasWhere = true;
    }

    if (filter?.status) {
      query += hasWhere ? ` AND status = ?` : ` WHERE status = ?`;
      params.push(filter.status);
      hasWhere = true;
    }
    if (filter?.priority) {
      query += hasWhere ? ` AND priority = ?` : ` WHERE priority = ?`;
      params.push(filter.priority);
      hasWhere = true;
    }
    query += ` ORDER BY updated_at DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map((row) => {
      const task = this.rowToTask(row);
      if (!task.shortId && this.shortIdAllocator) {
        const shortId = this.shortIdAllocator.allocate('task', task.roomId);
        this.db.prepare(`UPDATE tasks SET short_id = ? WHERE id = ?`).run(shortId, task.id);
        return { ...task, shortId };
      }
      return task;
    });
  }

  archiveTask(id: string): NeoTask | null {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE tasks SET status = 'archived', archived_at = ?, active_session = NULL, updated_at = ? WHERE id = ?`
    );
    const result = stmt.run(now, now, id);
    if (result.changes > 0) {
      this.reactiveDb.notifyChange('tasks');
    }
    return this.getTask(id);
  }

  private rowToTask(row: Record<string, unknown>): NeoTask {
    const restrictionsRaw = row.restrictions;
    const restrictionsJson = typeof restrictionsRaw === 'string' ? restrictionsRaw : null;
    return {
      id: row.id as string,
      roomId: row.room_id as string,
      shortId: (row.short_id as string | null) ?? undefined,
      title: row.title as string,
      description: row.description as string,
      status: row.status as NeoTask['status'],
      priority: row.priority as NeoTask['priority'],
      taskType: ((row.task_type as string | null) ?? 'coding') as NeoTask['taskType'],
      assignedAgent: ((row.assigned_agent as string | null) ?? 'coder') as NeoTask['assignedAgent'],
      createdByTaskId: (row.created_by_task_id as string | null) ?? undefined,
      progress: (row.progress as number | null) ?? undefined,
      currentStep: (row.current_step as string | null) ?? undefined,
      result: (row.result as string | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      dependsOn: JSON.parse(row.depends_on as string) as string[],
      inputDraft: (row.input_draft as string | null) ?? undefined,
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? undefined,
      completedAt: (row.completed_at as number | null) ?? undefined,
      archivedAt: (row.archived_at as number | null) ?? undefined,
      activeSession: (row.active_session as 'worker' | 'leader' | null) ?? null,
      prUrl: (row.pr_url as string | null) ?? undefined,
      prNumber: (row.pr_number as number | null) ?? undefined,
      prCreatedAt: (row.pr_created_at as number | null) ?? undefined,
      restrictions: restrictionsJson ? (JSON.parse(restrictionsJson) as TaskRestriction) : null,
      updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
    };
  }
}
