export type {
  GitHubEvent,
  GitHubEventSource,
  GitHubFilterConfig,
  GitHubAuthorFilter,
  GitHubLabelFilter,
  GitHubEventFilter,
  InboxItem,
  InboxItemStatus,
  SecurityCheckResult,
  RoomGitHubMapping,
  RepositoryMapping,
  CreateRoomGitHubMappingParams,
  UpdateRoomGitHubMappingParams,
  RoutingDecision,
  RoutingResult,
  FilterResult,
} from '@hyperneo/shared';

export interface WebhookPayload {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}

export interface SignatureVerificationResult {
  valid: boolean;
  error?: string;
}

export interface WebhookParseResult {
  event: import('@hyperneo/shared').GitHubEvent | null;
  error?: string;
}

export interface RepositoryPollState {
  owner: string;
  repo: string;
  lastPollTime: string;
  issuesEtag?: string;
  commentsEtag?: string;
}

export interface PollingConfig {
  token: string;
  interval: number;
  baseUrl?: string;
  userAgent?: string;
}

export interface GitHubApiResponse {
  data: unknown[];
  etag?: string;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  notModified?: boolean;
}

export interface PollingEvent {
  type: 'issue' | 'comment' | 'pull_request';
  data: unknown;
}

export interface GitHubApiIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  user: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
  updated_at: string;
  created_at: string;
  pull_request?: {
    url: string;
  };
}

export interface GitHubApiComment {
  id: number;
  body: string | null;
  user: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
  updated_at: string;
  created_at: string;
  issue_url: string;
}

export interface GitHubWebhookIssuesPayload {
  action: 'opened' | 'reopened' | 'closed' | 'edited';
  issue: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    state: 'open' | 'closed';
    user: {
      login: string;
      type: 'User' | 'Bot' | 'Organization';
    };
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
}

export interface GitHubWebhookIssueCommentPayload {
  action: 'created' | 'edited' | 'deleted';
  issue: {
    id: number;
    number: number;
    title: string;
    pull_request?: {
      url: string;
    };
  };
  comment: {
    id: number;
    body: string | null;
    user: {
      login: string;
      type: 'User' | 'Bot' | 'Organization';
    };
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
}

export interface GitHubWebhookPullRequestPayload {
  action: 'opened' | 'synchronize' | 'closed' | 'reopened' | 'edited';
  pull_request: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    user: {
      login: string;
      type: 'User' | 'Bot' | 'Organization';
    };
    labels: Array<{ name: string }>;
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
}
