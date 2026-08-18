import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  NeoTask,
  TaskFilter,
  CreateTaskParams,
  UpdateTaskParams,
  TaskRestriction,
} from '@hyperneo/shared/types/neo';
import type { SQLiteValue } from '../types';
import type { ReactiveDatabase } from '../reactive-database';
import type { ShortIdAllocator } from '../../lib/short-id-allocator';

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

  promoteDraftTasksByCreator(createdByTaskId: string): number {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'pending', updated_at = ? WHERE created_by_task_id = ? AND status = 'draft'`
      )
      .run(Date.now(), createdByTaskId);
    if (result.changes > 0) {
      this.reactiveDb.notifyChange('tasks');
    }
    return result.changes;
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

  updateTask(id: string, params: UpdateTaskParams): NeoTask | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.title !== undefined) {
      fields.push('title = ?');
      values.push(params.title);
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description);
    }
    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);

      if (params.status === 'in_progress') {
        fields.push('started_at = ?');
        values.push(Date.now());
      } else if (
        params.status === 'completed' ||
        params.status === 'needs_attention' ||
        params.status === 'cancelled'
      ) {
        fields.push('completed_at = ?');
        values.push(Date.now());
      } else if (params.status === 'archived') {
        fields.push('archived_at = ?');
        values.push(Date.now());
      }
    }
    if (params.priority !== undefined) {
      fields.push('priority = ?');
      values.push(params.priority);
    }
    if (params.progress !== undefined) {
      fields.push('progress = ?');
      values.push(params.progress);
    }
    if (params.currentStep !== undefined) {
      fields.push('current_step = ?');
      values.push(params.currentStep ?? null);
    }
    if (params.result !== undefined) {
      fields.push('result = ?');
      values.push(params.result ?? null);
    }
    if (params.error !== undefined) {
      fields.push('error = ?');
      values.push(params.error ?? null);
    }
    if (params.dependsOn !== undefined) {
      fields.push('depends_on = ?');
      values.push(JSON.stringify(params.dependsOn));
    }
    if (params.activeSession !== undefined) {
      fields.push('active_session = ?');
      values.push(params.activeSession ?? null);
    }
    if (
      params.activeSession === undefined &&
      (params.status === 'completed' ||
        params.status === 'needs_attention' ||
        params.status === 'cancelled' ||
        params.status === 'archived')
    ) {
      fields.push('active_session = ?');
      values.push(null);
    }
    if (params.prUrl !== undefined) {
      fields.push('pr_url = ?');
      values.push(params.prUrl ?? null);
    }
    if (params.prNumber !== undefined) {
      fields.push('pr_number = ?');
      values.push(params.prNumber ?? null);
    }
    if (params.prCreatedAt !== undefined) {
      fields.push('pr_created_at = ?');
      values.push(params.prCreatedAt ?? null);
    }
    if (params.archivedAt !== undefined) {
      fields.push('archived_at = ?');
      values.push(params.archivedAt ?? null);
    }
    if (params.inputDraft !== undefined) {
      fields.push('input_draft = ?');
      values.push(params.inputDraft ?? null);
    }
    if (params.restrictions !== undefined) {
      fields.push('restrictions = ?');
      values.push(params.restrictions !== null ? JSON.stringify(params.restrictions) : null);
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      const stmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      this.reactiveDb.notifyChange('tasks');
    }

    return this.getTask(id);
  }

  deleteTask(id: string): void {
    const stmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.reactiveDb.notifyChange('tasks');
    }
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

  deleteTasksForRoom(roomId: string): void {
    const stmt = this.db.prepare(`DELETE FROM tasks WHERE room_id = ?`);
    const result = stmt.run(roomId);
    if (result.changes > 0) {
      this.reactiveDb.notifyChange('tasks');
    }
  }

  countTasksByStatus(roomId: string, status: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE room_id = ? AND status = ?`
    );
    const result = stmt.get(roomId, status) as { count: number };
    return result.count;
  }

  countActiveTasks(roomId: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE room_id = ? AND status NOT IN ('completed', 'needs_attention', 'cancelled', 'archived')`
    );
    const result = stmt.get(roomId) as { count: number };
    return result.count;
  }

  getDraftTasksByCreator(createdByTaskId: string): NeoTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE created_by_task_id = ? AND status = 'draft' ORDER BY created_at ASC`
      )
      .all(createdByTaskId) as Record<string, unknown>[];
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
