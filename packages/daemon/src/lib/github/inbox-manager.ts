import type { Database } from '../../storage/database';
import type { InboxItem, InboxItemStatus, GitHubEvent, SecurityCheckResult } from './types';

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

export class InboxManager {
  constructor(private db: Database) {}

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

  getPendingItems(limit?: number): InboxItem[] {
    return this.db.listPendingInboxItems(limit);
  }

  getItem(id: string): InboxItem | null {
    return this.db.getInboxItem(id);
  }

  routeItem(id: string, roomId: string): InboxItem | null {
    return this.db.routeInboxItem(id, roomId);
  }

  dismissItem(id: string): InboxItem | null {
    return this.db.dismissInboxItem(id);
  }

  blockItem(id: string, _reason: string): InboxItem | null {
    const item = this.db.updateInboxItemStatus(id, 'blocked');
    return item;
  }

  deleteItem(id: string): void {
    this.db.deleteInboxItem(id);
  }

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

  listItems(filter?: {
    status?: InboxItemStatus;
    repository?: string;
    limit?: number;
  }): InboxItem[] {
    return this.db.listInboxItems(filter);
  }

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
