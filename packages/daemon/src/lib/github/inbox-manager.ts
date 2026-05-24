/**
 * Inbox Manager
 *
 * Manages the inbox of pending GitHub items awaiting routing.
 * Provides CRUD operations and status transitions for inbox items.
 */

import type { Database } from '../../storage/database';
import type { InboxItem, InboxItemStatus, GitHubEvent, SecurityCheckResult } from './types';

/**
 * Parameters for creating an inbox item
 */
interface CreateInboxItemParams {
  source: 'github_issue' | 'github_comment' | 'github_pr';
  repository: string;
  issueNumber: number;
  commentId?: string;
  title: string;
  body: string;
  author: string;
  labels: string[];
  securityCheck: SecurityCheckResult;
  rawEvent: unknown;
}

/**
 * Inbox Manager
 *
 * Provides high-level operations for managing inbox items.
 * Delegates to Database's InboxItemRepository for persistence.
 */
export class InboxManager {
  constructor(private db: Database) {}

  /**
   * Add an item to the inbox
   */
  addToInbox(event: GitHubEvent, securityResult: SecurityCheckResult, _reason: string): InboxItem {
    const source = this.getEventType(event);
    const body = event.comment?.body ?? event.issue?.body ?? '';

    const params: CreateInboxItemParams = {
      source,
      repository: event.repository.fullName,
      issueNumber: event.issue?.number ?? 0,
      commentId: event.comment?.id,
      title: event.issue?.title ?? '',
      body,
      author: event.sender.login,
      labels: event.issue?.labels ?? [],
      securityCheck: securityResult,
      rawEvent: event.rawPayload,
    };

    const item = this.db.createInboxItem({
      source: params.source,
      repository: params.repository,
      issueNumber: params.issueNumber,
      commentId: params.commentId,
      title: params.title,
      body: params.body,
      author: params.author,
      labels: params.labels,
      securityCheck: params.securityCheck,
      rawEvent: params.rawEvent,
    });

    return item;
  }

  /**
   * Get pending inbox items
   */
  getPendingItems(limit?: number): InboxItem[] {
    return this.db.listPendingInboxItems(limit);
  }

  /**
   * Get a single inbox item by ID
   */
  getItem(id: string): InboxItem | null {
    return this.db.getInboxItem(id);
  }

  /**
   * Route an item to a room (mark as routed)
   */
  routeItem(id: string, roomId: string): InboxItem | null {
    return this.db.routeInboxItem(id, roomId);
  }

  /**
   * Dismiss an item (mark as dismissed)
   */
  dismissItem(id: string): InboxItem | null {
    return this.db.dismissInboxItem(id);
  }

  /**
   * Block an item due to security concern
   */
  blockItem(id: string, _reason: string): InboxItem | null {
    // First update status to blocked
    const item = this.db.updateInboxItemStatus(id, 'blocked');
    // Note: The reason could be stored in a separate field or appended to a notes field
    // For now, the existing schema doesn't have a block reason field
    return item;
  }

  /**
   * Delete an item from the inbox
   */
  deleteItem(id: string): void {
    this.db.deleteInboxItem(id);
  }

  /**
   * Count items by status
   */
  countByStatus(): Record<InboxItemStatus, number> {
    const statuses: InboxItemStatus[] = ['pending', 'routed', 'dismissed', 'blocked'];
    const counts: Record<InboxItemStatus, number> = {
      pending: 0,
      routed: 0,
      dismissed: 0,
      blocked: 0,
    };

    for (const status of statuses) {
      counts[status] = this.db.countInboxItemsByStatus(status);
    }

    return counts;
  }

  /**
   * List all inbox items with optional filter
   */
  listItems(filter?: {
    status?: InboxItemStatus;
    repository?: string;
    limit?: number;
  }): InboxItem[] {
    return this.db.listInboxItems(filter);
  }

  /**
   * Determine the source type from a GitHub event
   */
  private getEventType(event: GitHubEvent): 'github_issue' | 'github_comment' | 'github_pr' {
    if (event.eventType === 'issue_comment') {
      return 'github_comment';
    }
    if (event.eventType === 'pull_request') {
      return 'github_pr';
    }
    return 'github_issue';
  }
}
