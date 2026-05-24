/**
 * GitHub Integration Types
 *
 * Types for GitHub event monitoring, filtering, and routing to NeoKai rooms.
 */

// ============================================================================
// Event Source Types
// ============================================================================

/**
 * Source of GitHub events
 */
export type GitHubEventSource = 'webhook' | 'polling';

// ============================================================================
// Normalized GitHub Event
// ============================================================================

/**
 * Normalized GitHub event structure
 * Represents events from both webhooks and polling
 */
export interface GitHubEvent {
  /** Unique event identifier */
  id: string;
  /** Source of the event (webhook or polling) */
  source: GitHubEventSource;
  /** Type of GitHub event */
  eventType: 'issues' | 'issue_comment' | 'pull_request';
  /** Action that triggered the event (e.g., 'opened', 'created') */
  action: string;
  /** Repository information */
  repository: {
    owner: string;
    repo: string;
    fullName: string;
  };
  /** Issue details (for issues and issue_comment events) */
  issue?: {
    number: number;
    title: string;
    body: string;
    labels: string[];
  };
  /** Comment details (for issue_comment events) */
  comment?: {
    id: string;
    body: string;
  };
  /** User who triggered the event */
  sender: {
    login: string;
    type: 'User' | 'Bot' | 'Organization';
  };
  /** Original payload from GitHub */
  rawPayload: unknown;
  /** Timestamp when event was received */
  receivedAt: number;
}

// ============================================================================
// Filter Configuration
// ============================================================================

/**
 * Author filtering configuration
 */
export interface GitHubAuthorFilter {
  /** Filtering mode */
  mode: 'allowlist' | 'blocklist' | 'all';
  /** List of usernames to allow/block */
  users?: string[];
  /** List of team slugs to allow/block */
  teams?: string[];
  /** Minimum repository permission required */
  minPermission?: 'admin' | 'maintain' | 'write' | 'read' | 'none';
}

/**
 * Label filtering configuration
 */
export interface GitHubLabelFilter {
  /** Filtering mode */
  mode: 'require_any' | 'require_all' | 'exclude' | 'any';
  /** List of label names */
  labels?: string[];
}

/**
 * Event type filtering configuration
 */
export interface GitHubEventFilter {
  /** Issue events to include */
  issues?: ('opened' | 'reopened' | 'closed' | 'edited')[];
  /** Issue comment events to include */
  issue_comment?: ('created' | 'edited' | 'deleted')[];
  /** Pull request events to include */
  pull_request?: ('opened' | 'synchronize' | 'closed')[];
}

/**
 * Complete GitHub filter configuration
 */
export interface GitHubFilterConfig {
  /** List of repository full names (owner/repo) to monitor */
  repositories: string[];
  /** Author filtering rules */
  authors: GitHubAuthorFilter;
  /** Label filtering rules */
  labels: GitHubLabelFilter;
  /** Event type filtering rules */
  events: GitHubEventFilter;
}

// ============================================================================
// Inbox Types
// ============================================================================

/**
 * Status of an inbox item
 */
export type InboxItemStatus = 'pending' | 'routed' | 'dismissed' | 'blocked';

/**
 * Security check result for an inbox item
 */
export interface SecurityCheckResult {
  /** Whether the item passed security checks */
  passed: boolean;
  /** Reason for failure if not passed */
  reason?: string;
  /** Assessed injection risk level */
  injectionRisk: 'none' | 'low' | 'medium' | 'high';
}

/**
 * An item in the GitHub inbox awaiting routing
 */
export interface InboxItem {
  /** Unique identifier */
  id: string;
  /** Source type of this item */
  source: 'github_issue' | 'github_comment' | 'github_pr';
  /** Repository full name (owner/repo) */
  repository: string;
  /** Issue or PR number */
  issueNumber: number;
  /** Comment ID if this is a comment */
  commentId?: string;
  /** Title of the issue/PR */
  title: string;
  /** Body content */
  body: string;
  /** Author username */
  author: string;
  /** Author's permission level in the repository */
  authorPermission?: string;
  /** Labels on the issue/PR */
  labels: string[];
  /** Current status */
  status: InboxItemStatus;
  /** ID of room this was routed to */
  routedToRoomId?: string;
  /** Timestamp when routed */
  routedAt?: number;
  /** Security check results */
  securityCheck: SecurityCheckResult;
  /** Original GitHub event payload */
  rawEvent: unknown;
  /** Timestamp when received */
  receivedAt: number;
  /** Timestamp when last updated */
  updatedAt: number;
}

// ============================================================================
// Room Mapping Types
// ============================================================================

/**
 * Repository mapping configuration for a room
 */
export interface RepositoryMapping {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Optional label filter for this mapping */
  labels?: string[];
  /** Optional specific issue numbers to route */
  issueNumbers?: number[];
}

/**
 * GitHub mapping for a room
 * Defines which GitHub events should be routed to which room
 */
export interface RoomGitHubMapping {
  /** Unique identifier */
  id: string;
  /** ID of the room to route events to */
  roomId: string;
  /** Repository mappings for this room */
  repositories: RepositoryMapping[];
  /** Priority for routing (higher = more specific) */
  priority: number;
  /** Creation timestamp (milliseconds since epoch) */
  createdAt: number;
  /** Last update timestamp (milliseconds since epoch) */
  updatedAt: number;
}

/**
 * Parameters for creating a new room GitHub mapping
 */
export interface CreateRoomGitHubMappingParams {
  roomId: string;
  repositories: RepositoryMapping[];
  priority?: number;
}

/**
 * Parameters for updating a room GitHub mapping
 */
export interface UpdateRoomGitHubMappingParams {
  repositories?: RepositoryMapping[];
  priority?: number;
}

// ============================================================================
// Routing Types
// ============================================================================

/**
 * Routing decision result
 */
export type RoutingDecision = 'route' | 'inbox' | 'reject';

/**
 * Result of a routing decision
 */
export interface RoutingResult {
  /** Final routing decision */
  decision: RoutingDecision;
  /** Room ID if routed */
  roomId?: string;
  /** Confidence level of the decision */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable reason for the decision */
  reason: string;
  /** Security check results */
  securityCheck: SecurityCheckResult;
}

/**
 * Result of filter evaluation
 */
export interface FilterResult {
  /** Whether the event passed the filter */
  passed: boolean;
  /** Reason for failure if not passed */
  reason?: string;
}
