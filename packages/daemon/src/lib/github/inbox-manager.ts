import { generateUUID } from '@hyperneo/shared';
import { inboxCreateWrites } from '../../storage/repositories/inbox-create-write.ts';
import type { Database } from '../../storage/database.ts';
import type { InboxItem, InboxItemStatus, GitHubEvent, SecurityCheckResult } from './types.ts';

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

  addToInbox(
    event: GitHubEvent,
    securityResult: SecurityCheckResult,
    _reason: string
  ): Promise<InboxItem> {
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

    return this.db.gateway.call(inboxCreateWrites, 'create', params, generateUUID(), Date.now());
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
