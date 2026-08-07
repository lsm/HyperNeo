/**
 * Inbox Item Repository
 *
 * Repository for GitHub inbox item CRUD operations.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type { InboxItem, InboxItemStatus, SecurityCheckResult } from '@hyperneo/shared';
import type { SQLiteValue } from '../types';

/**
 * Parameters for creating a new inbox item
 */
export interface CreateInboxItemParams {
  source: 'github_issue' | 'github_comment' | 'github_pr';
  repository: string;
  issueNumber: number;
  commentId?: string;
  title: string;
  body: string;
  author: string;
  authorPermission?: string;
  labels: string[];
  securityCheck: SecurityCheckResult;
  rawEvent: unknown;
}

/**
 * Filter options for querying inbox items
 */
export interface InboxItemFilter {
  status?: InboxItemStatus;
  repository?: string;
  issueNumber?: number;
  limit?: number;
  offset?: number;
}

export class InboxItemRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Create a new inbox item
   */
  createItem(params: CreateInboxItemParams): InboxItem {
    const id = generateUUID();
    const now = Date.now();

    const stmt = this.db.prepare(
      `INSERT INTO inbox_items (
        id, source, repository, issue_number, comment_id, title, body,
        author, author_permission, labels, status, routed_to_room_id, routed_at,
        security_check, raw_event, received_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.source,
      params.repository,
      params.issueNumber,
      params.commentId ?? null,
      params.title,
      params.body,
      params.author,
      params.authorPermission ?? null,
      JSON.stringify(params.labels),
      'pending',
      null,
      null,
      JSON.stringify(params.securityCheck),
      JSON.stringify(params.rawEvent),
      now,
      now
    );

    return this.getItem(id)!;
  }

  /**
   * Get an item by ID
   */
  getItem(id: string): InboxItem | null {
    const stmt = this.db.prepare(`SELECT * FROM inbox_items WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToItem(row);
  }

  /**
   * List items with optional filtering
   */
  listItems(filter?: InboxItemFilter): InboxItem[] {
    let query = `SELECT * FROM inbox_items`;
    const conditions: string[] = [];
    const values: SQLiteValue[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.repository) {
      conditions.push('repository = ?');
      values.push(filter.repository);
    }
    if (filter?.issueNumber !== undefined) {
      conditions.push('issue_number = ?');
      values.push(filter.issueNumber);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY received_at DESC`;

    if (filter?.limit) {
      query += ` LIMIT ?`;
      values.push(filter.limit);
    }
    if (filter?.offset) {
      query += ` OFFSET ?`;
      values.push(filter.offset);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...values) as Record<string, unknown>[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * List pending items
   */
  listPendingItems(limit = 50): InboxItem[] {
    return this.listItems({ status: 'pending', limit });
  }

  /**
   * Update item status
   */
  updateItemStatus(id: string, status: InboxItemStatus, routedToRoomId?: string): InboxItem | null {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const values: SQLiteValue[] = [status, Date.now()];

    if (routedToRoomId !== undefined) {
      fields.push('routed_to_room_id = ?');
      values.push(routedToRoomId);
      fields.push('routed_at = ?');
      values.push(Date.now());
    }

    values.push(id);
    const stmt = this.db.prepare(`UPDATE inbox_items SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return this.getItem(id);
  }

  /**
   * Dismiss an item
   */
  dismissItem(id: string): InboxItem | null {
    return this.updateItemStatus(id, 'dismissed');
  }

  /**
   * Mark item as routed to a room
   */
  routeItem(id: string, roomId: string): InboxItem | null {
    return this.updateItemStatus(id, 'routed', roomId);
  }

  /**
   * Mark item as blocked
   */
  blockItem(id: string): InboxItem | null {
    return this.updateItemStatus(id, 'blocked');
  }

  /**
   * Delete an item by ID
   */
  deleteItem(id: string): void {
    const stmt = this.db.prepare(`DELETE FROM inbox_items WHERE id = ?`);
    stmt.run(id);
  }

  /**
   * Delete all items for a specific repository
   */
  deleteItemsForRepository(repository: string): number {
    const stmt = this.db.prepare(`DELETE FROM inbox_items WHERE repository = ?`);
    const result = stmt.run(repository);
    return result.changes;
  }

  /**
   * Count items by status
   */
  countByStatus(status: InboxItemStatus): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM inbox_items WHERE status = ?`);
    const row = stmt.get(status) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Convert a database row to an InboxItem object
   */
  private rowToItem(row: Record<string, unknown>): InboxItem {
    return {
      id: row.id as string,
      source: row.source as 'github_issue' | 'github_comment' | 'github_pr',
      repository: row.repository as string,
      issueNumber: row.issue_number as number,
      commentId: (row.comment_id as string | null) ?? undefined,
      title: row.title as string,
      body: row.body as string,
      author: row.author as string,
      authorPermission: (row.author_permission as string | null) ?? undefined,
      labels: JSON.parse(row.labels as string) as string[],
      status: row.status as InboxItemStatus,
      routedToRoomId: (row.routed_to_room_id as string | null) ?? undefined,
      routedAt: (row.routed_at as number | null) ?? undefined,
      securityCheck: JSON.parse(row.security_check as string) as SecurityCheckResult,
      rawEvent: JSON.parse(row.raw_event as string) as unknown,
      receivedAt: row.received_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
