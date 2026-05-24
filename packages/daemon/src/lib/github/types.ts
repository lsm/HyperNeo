/**
 * GitHub Integration Types for Daemon
 *
 * Re-exports types from shared package and adds internal helper types
 * for webhook handling and polling services.
 */

// Re-export all GitHub types from shared package
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
} from '@neokai/shared';

// ============================================================================
// Internal Types for Webhook Handling
// ============================================================================

/**
 * Raw webhook payload from GitHub
 */
export interface WebhookPayload {
  /** GitHub event type (e.g., 'issues', 'issue_comment', 'pull_request') */
  eventType: string;
  /** Unique delivery ID from GitHub */
  deliveryId: string;
  /** Raw payload body */
  payload: unknown;
}

/**
 * Result of webhook signature verification
 */
export interface SignatureVerificationResult {
  /** Whether the signature is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
}

/**
 * Result of parsing a webhook event
 */
export interface WebhookParseResult {
  /** Parsed event or null if unsupported */
  event: import('@neokai/shared').GitHubEvent | null;
  /** Error message if parsing failed */
  error?: string;
}

// ============================================================================
// Internal Types for Polling Service
// ============================================================================

/**
 * State for polling a single repository
 */
export interface RepositoryPollState {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** ISO timestamp of last successful poll */
  lastPollTime: string;
  /** ETag for issues endpoint */
  issuesEtag?: string;
  /** ETag for comments endpoint */
  commentsEtag?: string;
}

/**
 * Configuration for the polling service
 */
export interface PollingConfig {
  /** GitHub personal access token */
  token: string;
  /** Polling interval in milliseconds */
  interval: number;
  /** Optional base URL for GitHub API (for testing) */
  baseUrl?: string;
  /** User agent for API requests */
  userAgent?: string;
}

/**
 * Response from GitHub API for issues/comments
 */
export interface GitHubApiResponse {
  /** Response data */
  data: unknown[];
  /** ETag for caching */
  etag?: string;
  /** Rate limit remaining */
  rateLimitRemaining?: number;
  /** Rate limit reset timestamp */
  rateLimitReset?: number;
  /** Whether response was from cache (304) */
  notModified?: boolean;
}

/**
 * Normalized event from polling
 */
export interface PollingEvent {
  /** Type of data polled */
  type: 'issue' | 'comment' | 'pull_request';
  /** Raw data from GitHub API */
  data: unknown;
}

// ============================================================================
// GitHub API Response Types (for parsing)
// ============================================================================

/**
 * GitHub API issue response shape
 */
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
    // Present if this is a PR
    url: string;
  };
}

/**
 * GitHub API comment response shape
 */
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

/**
 * GitHub Webhook payload for issues event
 */
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

/**
 * GitHub Webhook payload for issue_comment event
 */
export interface GitHubWebhookIssueCommentPayload {
  action: 'created' | 'edited' | 'deleted';
  issue: {
    id: number;
    number: number;
    title: string;
    pull_request?: {
      // Present if commenting on a PR
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

/**
 * GitHub Webhook payload for pull_request event
 */
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
