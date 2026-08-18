export type GitHubEventSource = 'webhook' | 'polling';

export interface GitHubEvent {
  id: string;
  source: GitHubEventSource;
  eventType: 'issues' | 'issue_comment' | 'pull_request';
  action: string;
  repository: {
    owner: string;
    repo: string;
    fullName: string;
  };
  issue?: {
    number: number;
    title: string;
    body: string;
    labels: string[];
  };
  comment?: {
    id: string;
    body: string;
  };
  sender: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
  rawPayload: unknown;
  receivedAt: number;
}

export interface GitHubAuthorFilter {
  mode: 'allowlist' | 'blocklist' | 'all';
  users?: string[];
  teams?: string[];
  minPermission?: 'admin' | 'maintain' | 'write' | 'read' | 'none';
}

export interface GitHubLabelFilter {
  mode: 'require_any' | 'require_all' | 'exclude' | 'any';
  labels?: string[];
}

export interface GitHubEventFilter {
  issues?: ('opened' | 'reopened' | 'closed' | 'edited')[];
  issue_comment?: ('created' | 'edited' | 'deleted')[];
  pull_request?: ('opened' | 'synchronize' | 'closed')[];
}

export interface GitHubFilterConfig {
  repositories: string[];
  authors: GitHubAuthorFilter;
  labels: GitHubLabelFilter;
  events: GitHubEventFilter;
}

export type InboxItemStatus = 'pending' | 'routed' | 'dismissed' | 'blocked';

export interface SecurityCheckResult {
  passed: boolean;
  reason?: string;
  injectionRisk: 'none' | 'low' | 'medium' | 'high';
}

export interface InboxItem {
  id: string;
  source: 'github_issue' | 'github_comment' | 'github_pr';
  repository: string;
  issueNumber: number;
  commentId?: string;
  title: string;
  body: string;
  author: string;
  authorPermission?: string;
  labels: string[];
  status: InboxItemStatus;
  routedToRoomId?: string;
  routedAt?: number;
  securityCheck: SecurityCheckResult;
  rawEvent: unknown;
  receivedAt: number;
  updatedAt: number;
}

export interface RepositoryMapping {
  owner: string;
  repo: string;
  labels?: string[];
  issueNumbers?: number[];
}

export interface RoomGitHubMapping {
  id: string;
  roomId: string;
  repositories: RepositoryMapping[];
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRoomGitHubMappingParams {
  roomId: string;
  repositories: RepositoryMapping[];
  priority?: number;
}

export interface UpdateRoomGitHubMappingParams {
  repositories?: RepositoryMapping[];
  priority?: number;
}

export type RoutingDecision = 'route' | 'inbox' | 'reject';

export interface RoutingResult {
  decision: RoutingDecision;
  roomId?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  securityCheck: SecurityCheckResult;
}

export interface FilterResult {
  passed: boolean;
  reason?: string;
}
