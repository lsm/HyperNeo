/**
 * GitHub Service Orchestrator
 *
 * The main orchestrator that ties all GitHub integration components together:
 * - Webhook handler for receiving events
 * - Polling service for checking repositories
 * - Event filter for applying rules
 * - Security agent for prompt injection detection
 * - Router agent for routing decisions
 * - Inbox manager for pending items
 */

import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Config } from '../../config';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobQueueProcessor } from '../../storage/job-queue-processor';
import { GITHUB_POLL } from '../job-queue-constants';
import { handleGitHubPoll } from '../job-handlers/github-poll.handler';
import type {
  GitHubEvent,
  RoutingResult,
  FilterResult,
  SecurityCheckResult,
  InboxItem,
  RoomGitHubMapping,
} from './types';
import { GitHubPollingService, createPollingService } from './polling-service';
import {
  GitHubEventFilter,
  createEventFilter,
  type GitHubEventFilterOptions,
} from './event-filter';
import { FilterConfigManager, createFilterConfigManager } from './filter-config-manager';
import { SecurityAgent, createSecurityAgent } from './security-agent';
import { RouterAgent, createRouterAgent, type RoomCandidate } from './router-agent';
import { InboxManager } from './inbox-manager';
import { createWebhookHandler } from './webhook-handler';
import { Logger } from '../logger';

const log = new Logger('github-service');
const DEFAULT_GITHUB_POLLING_INTERVAL_SECONDS = 120;

/**
 * Configuration options for the GitHub service
 */
export interface GitHubServiceOptions {
  /** Database instance for persistence */
  db: Database;
  /** InternalEventBus<DaemonInternalEventMap> for emitting events */
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  /** Application configuration */
  config: Config;
  /** API key for AI agents (security + routing) */
  apiKey: string;
  /** Credential type so agents set the correct SDK env var */
  apiKeyType?: 'api_key' | 'oauth';
  /** Optional GitHub token for polling and permission checks */
  githubToken?: string;
  /** Job queue repository — required to enqueue the initial github.poll job */
  jobQueue?: JobQueueRepository;
  /** Job queue processor — required to register the github.poll handler */
  jobProcessor?: JobQueueProcessor;
  /** Live global setting getter for GitHub polling interval in seconds */
  getPollingIntervalSeconds?: () => number | undefined;
}

/**
 * GitHub Service Orchestrator
 *
 * Coordinates the full pipeline for GitHub event processing:
 * 1. Receive event (webhook or polling)
 * 2. Filter event (repository, author, labels, event type)
 * 3. Security check (sandboxed AI)
 * 4. Find candidate rooms (database lookup)
 * 5. Route event (rule-based or AI)
 * 6. Deliver to room OR add to inbox
 * 7. Emit InternalEventBus<DaemonInternalEventMap> events at each step
 */
export class GitHubService {
  private db: Database;
  private internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  private config: Config;
  private apiKey: string;
  private apiKeyType?: 'api_key' | 'oauth';
  private githubToken?: string;

  private pollingService?: GitHubPollingService;
  private eventFilter: GitHubEventFilter;
  private filterConfigManager: FilterConfigManager;
  private securityAgent: SecurityAgent;
  private routerAgent: RouterAgent;
  private inboxManager: InboxManager;
  private webhookHandler?: (req: Request) => Promise<Response>;
  private jobQueue?: JobQueueRepository;
  private jobProcessor?: JobQueueProcessor;
  private getPollingIntervalSeconds?: () => number | undefined;
  private pollJobHandlerRegistered = false;

  constructor(options: GitHubServiceOptions) {
    this.db = options.db;
    this.internalEventBus = options.internalEventBus;
    this.config = options.config;
    this.apiKey = options.apiKey;
    this.apiKeyType = options.apiKeyType;
    this.githubToken = options.githubToken;
    this.jobQueue = options.jobQueue;
    this.jobProcessor = options.jobProcessor;
    this.getPollingIntervalSeconds = options.getPollingIntervalSeconds;

    // Initialize filter config manager
    this.filterConfigManager = createFilterConfigManager(this.db.getDatabase());

    // Initialize event filter with manager for dynamic configs
    const filterOptions: GitHubEventFilterOptions = {
      githubToken: this.githubToken,
      configManager: this.filterConfigManager,
    };
    this.eventFilter = createEventFilter(this.filterConfigManager.getGlobalFilter(), filterOptions);

    // Initialize security agent
    this.securityAgent = createSecurityAgent({
      apiKey: this.apiKey,
      apiKeyType: this.apiKeyType,
    });

    // Initialize router agent
    this.routerAgent = createRouterAgent({
      apiKey: this.apiKey,
      apiKeyType: this.apiKeyType,
    });

    // Initialize inbox manager
    this.inboxManager = new InboxManager(this.db);

    log.info('GitHubService initialized', {
      hasWebhookSecret: !!this.config.githubWebhookSecret,
      pollingInterval: this.getPollingIntervalSecondsValue(),
      hasApiKey: !!this.apiKey,
    });
  }

  /**
   * Start the GitHub service.
   * - Creates webhook handler if secret is configured.
   * - Creates and starts the polling service if polling is configured.
   * - Registers the github.poll job handler and enqueues the initial job when
   *   both jobProcessor/jobQueue and polling are configured.
   */
  start(): void {
    // Initialize webhook handler if secret is configured
    if (this.config.githubWebhookSecret) {
      this.webhookHandler = createWebhookHandler(this.config.githubWebhookSecret, async (event) => {
        await this.processEvent(event);
      });
      log.info('Webhook handler initialized');
    }

    this.refreshPolling();

    log.info('GitHub service started');
  }

  refreshPolling(): void {
    const intervalSeconds = this.getPollingIntervalSecondsValue();

    if (intervalSeconds <= 0 || !this.githubToken) {
      if (this.pollingService) {
        this.pollingService.stop();
        this.pollingService = undefined;
        log.info('Polling service stopped', { intervalSeconds });
      }
      return;
    }

    const intervalMs = intervalSeconds * 1000;

    if (!this.pollingService) {
      this.pollingService = createPollingService(
        {
          token: this.githubToken,
          interval: intervalMs,
        },
        async (event) => {
          await this.processEvent(event);
        }
      );
    }

    if (this.jobProcessor && this.jobQueue) {
      if (!this.pollingService.isRunning()) {
        this.pollingService.start();
        log.info('Polling service started (job-queue-driven)', { intervalMs });
      }

      if (!this.pollJobHandlerRegistered) {
        this.jobProcessor.register(GITHUB_POLL, () =>
          handleGitHubPoll({
            pollingService: this.pollingService,
            jobQueue: this.jobQueue!,
            intervalMs: this.getPollingIntervalSecondsValue() * 1000,
          })
        );
        this.pollJobHandlerRegistered = true;
        log.info('github.poll job handler registered');
      }

      const existing = this.jobQueue.listJobs({
        queue: GITHUB_POLL,
        status: ['pending', 'processing'],
        limit: 1,
      });
      if (existing.length === 0) {
        this.jobQueue.enqueue({ queue: GITHUB_POLL, payload: {}, runAt: Date.now() });
        log.info('Enqueued initial github.poll job');
      }
    }
  }

  private getPollingIntervalSecondsValue(): number {
    const configured = this.getPollingIntervalSeconds?.();
    if (configured === undefined || !Number.isFinite(configured)) {
      return DEFAULT_GITHUB_POLLING_INTERVAL_SECONDS;
    }
    return Math.max(0, Math.trunc(configured));
  }

  /**
   * Stop the GitHub service
   */
  stop(): void {
    if (this.pollingService) {
      this.pollingService.stop();
      this.pollingService = undefined;
    }

    this.webhookHandler = undefined;

    log.info('GitHub service stopped');
  }

  /**
   * Handle incoming webhook request
   */
  async handleWebhook(req: Request): Promise<Response> {
    if (!this.webhookHandler) {
      return new Response(JSON.stringify({ error: 'Webhook handler not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return this.webhookHandler(req);
  }

  /**
   * Main event processing pipeline
   */
  async processEvent(event: GitHubEvent): Promise<RoutingResult> {
    log.debug('Processing GitHub event', {
      eventId: event.id,
      eventType: event.eventType,
      action: event.action,
      repository: event.repository.fullName,
    });

    // Emit event received
    this.emitEvent('github.eventReceived', {
      sessionId: 'global',
      event,
    });

    try {
      // Step 1: Filter event
      const filterResult = await this.filterEvent(event);
      if (!filterResult.passed) {
        log.debug('Event filtered out', {
          eventId: event.id,
          reason: filterResult.reason,
        });

        this.emitEvent('github.eventFiltered', {
          sessionId: 'global',
          eventId: event.id,
          reason: filterResult.reason,
        });

        return {
          decision: 'reject',
          confidence: 'high',
          reason: filterResult.reason ?? 'Event did not pass filter',
          securityCheck: {
            passed: true,
            injectionRisk: 'none',
          },
        };
      }

      // Step 2: Security check
      const securityResult = await this.checkSecurity(event);
      if (!securityResult.passed) {
        log.warn('Event failed security check', {
          eventId: event.id,
          reason: securityResult.reason,
          injectionRisk: securityResult.injectionRisk,
        });

        this.emitEvent('github.eventSecurityFailed', {
          sessionId: 'global',
          eventId: event.id,
          securityResult,
        });

        // Add to inbox as blocked item
        const item = this.addToInbox(event, securityResult, 'Security check failed');
        this.emitEvent('github.inboxItemAdded', {
          sessionId: 'global',
          item,
          reason: 'Security check failed',
        });

        return {
          decision: 'reject',
          confidence: 'high',
          reason: `Security check failed: ${securityResult.reason}`,
          securityCheck: securityResult,
        };
      }

      // Step 3: Find candidate rooms
      const candidates = this.findCandidates(event);
      log.debug('Found candidate rooms', {
        eventId: event.id,
        candidateCount: candidates.length,
      });

      // Step 4: Route event
      const routingResult = await this.routeEvent(event, candidates, securityResult);

      // Step 5: Execute routing decision
      if (routingResult.decision === 'route' && routingResult.roomId) {
        this.deliverToRoom(event, routingResult.roomId);
        log.info('Event routed to room', {
          eventId: event.id,
          roomId: routingResult.roomId,
          confidence: routingResult.confidence,
        });

        this.emitEvent('github.eventRouted', {
          sessionId: 'global',
          eventId: event.id,
          roomId: routingResult.roomId,
          confidence: routingResult.confidence,
          reason: routingResult.reason,
        });
      } else if (routingResult.decision === 'inbox') {
        const item = this.addToInbox(event, securityResult, routingResult.reason);
        log.info('Event added to inbox', {
          eventId: event.id,
          inboxItemId: item.id,
          reason: routingResult.reason,
        });

        this.emitEvent('github.inboxItemAdded', {
          sessionId: 'global',
          item,
          reason: routingResult.reason,
        });
      }

      return routingResult;
    } catch (error) {
      log.error('Error processing event', {
        eventId: event.id,
        error: error instanceof Error ? error.message : error,
      });

      // Add to inbox on error for manual triage
      const item = this.addToInbox(
        event,
        { passed: true, injectionRisk: 'low' },
        `Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );

      this.emitEvent('github.eventError', {
        sessionId: 'global',
        eventId: event.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        inboxItemId: item.id,
      });

      return {
        decision: 'inbox',
        confidence: 'low',
        reason: `Processing error, sent to inbox: ${error instanceof Error ? error.message : 'Unknown error'}`,
        securityCheck: {
          passed: true,
          injectionRisk: 'low',
        },
      };
    }
  }

  /**
   * Filter event based on configuration rules
   */
  private async filterEvent(event: GitHubEvent): Promise<FilterResult> {
    return this.eventFilter.filter(event);
  }

  /**
   * Check event content for security risks
   */
  private async checkSecurity(event: GitHubEvent): Promise<SecurityCheckResult> {
    const content = event.comment?.body ?? event.issue?.body ?? '';
    const title = event.issue?.title;

    return this.securityAgent.check(content, {
      title,
      author: event.sender.login,
    });
  }

  /**
   * Find candidate rooms for an event based on repository mappings
   */
  private findCandidates(event: GitHubEvent): RoomCandidate[] {
    const mappings = this.db.listGitHubMappingsForRepository(
      event.repository.owner,
      event.repository.repo
    );

    const candidates: RoomCandidate[] = [];

    for (const mapping of mappings) {
      // Check if this mapping matches the event
      if (this.mappingMatchesEvent(mapping, event)) {
        candidates.push({
          roomId: mapping.roomId,
          roomName: mapping.roomId, // Room name would come from room store
          repositories: mapping.repositories.map((r) => `${r.owner}/${r.repo}`),
          priority: mapping.priority,
        });
      }
    }

    // Sort by priority (highest first)
    candidates.sort((a, b) => b.priority - a.priority);

    return candidates;
  }

  /**
   * Check if a mapping matches an event
   */
  private mappingMatchesEvent(mapping: RoomGitHubMapping, event: GitHubEvent): boolean {
    for (const repoMapping of mapping.repositories) {
      // Check repository match
      if (
        repoMapping.owner !== event.repository.owner ||
        repoMapping.repo !== event.repository.repo
      ) {
        continue;
      }

      // Check issue number filter if specified
      if (repoMapping.issueNumbers && repoMapping.issueNumbers.length > 0) {
        if (!event.issue || !repoMapping.issueNumbers.includes(event.issue.number)) {
          continue;
        }
      }

      // Check label filter if specified
      if (repoMapping.labels && repoMapping.labels.length > 0) {
        const eventLabels = event.issue?.labels ?? [];
        if (!repoMapping.labels.some((label) => eventLabels.includes(label))) {
          continue;
        }
      }

      // All checks passed
      return true;
    }

    return false;
  }

  /**
   * Route an event using rule-based or AI routing
   */
  private async routeEvent(
    event: GitHubEvent,
    candidates: RoomCandidate[],
    securityResult: SecurityCheckResult
  ): Promise<RoutingResult> {
    return this.routerAgent.route(event, candidates, securityResult);
  }

  /**
   * Deliver an event to a room
   */
  private deliverToRoom(event: GitHubEvent, roomId: string): void {
    // Emit a room message event for the room to handle
    this.emitEvent('room.message', {
      sessionId: `room:${roomId}`,
      roomId,
      message: {
        id: event.id,
        role: 'github_event',
        content: this.formatEventContent(event),
        timestamp: Date.now(),
      },
      sender: event.sender.login,
    });

    log.debug('Event delivered to room', {
      eventId: event.id,
      roomId,
    });
  }

  /**
   * Add an event to the inbox
   */
  private addToInbox(event: GitHubEvent, security: SecurityCheckResult, reason: string): InboxItem {
    return this.inboxManager.addToInbox(event, security, reason);
  }

  /**
   * Format event content for room message
   */
  private formatEventContent(event: GitHubEvent): string {
    const parts: string[] = [];

    parts.push(`**${event.eventType.replace('_', ' ')} ${event.action}**`);
    parts.push(`Repository: ${event.repository.fullName}`);

    if (event.issue) {
      parts.push(`Issue #${event.issue.number}: ${event.issue.title}`);
    }

    if (event.comment) {
      parts.push(
        `Comment: ${event.comment.body.substring(0, 200)}${event.comment.body.length > 200 ? '...' : ''}`
      );
    } else if (event.issue?.body) {
      parts.push(
        `Body: ${event.issue.body.substring(0, 200)}${event.issue.body.length > 200 ? '...' : ''}`
      );
    }

    if (event.issue?.labels.length) {
      parts.push(`Labels: ${event.issue.labels.join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Emit an event to InternalEventBus<DaemonInternalEventMap>
   */
  private emitEvent<K extends keyof DaemonInternalEventMap & string>(
    event: K,
    data: DaemonInternalEventMap[K]
  ): void {
    try {
      this.internalEventBus.publishAsync(
        event,
        data as DaemonInternalEventMap[K] & { sessionId: string } & Record<string, unknown>
      );
    } catch {
      // Best-effort telemetry: never let a hub emission failure
      // abort event routing or inbox fallback.
    }
  }

  // ============================================================================
  // Repository Management
  // ============================================================================

  /**
   * Add a repository to polling
   */
  addRepository(owner: string, repo: string): void {
    if (this.pollingService) {
      this.pollingService.addRepository(owner, repo);
    }

    // Also add to filter config
    this.filterConfigManager.addRepositories([`${owner}/${repo}`]);

    log.info('Repository added', { owner, repo });
  }

  /**
   * Remove a repository from polling
   */
  removeRepository(owner: string, repo: string): void {
    if (this.pollingService) {
      this.pollingService.removeRepository(owner, repo);
    }

    // Also remove from filter config
    this.filterConfigManager.removeRepositories([`${owner}/${repo}`]);

    log.info('Repository removed', { owner, repo });
  }

  /**
   * Get list of repositories being polled
   */
  getPolledRepositories(): Array<{ owner: string; repo: string }> {
    if (!this.pollingService) {
      return [];
    }
    return this.pollingService.getRepositories();
  }

  // ============================================================================
  // Inbox Access
  // ============================================================================

  /**
   * Get the inbox manager
   */
  getInboxManager(): InboxManager {
    return this.inboxManager;
  }

  /**
   * Get pending inbox count
   */
  getPendingInboxCount(): number {
    return this.inboxManager.countByStatus().pending;
  }

  // ============================================================================
  // Filter Configuration
  // ============================================================================

  /**
   * Get the filter config manager
   */
  getFilterConfigManager(): FilterConfigManager {
    return this.filterConfigManager;
  }

  /**
   * Check if the service is running
   */
  isRunning(): boolean {
    return this.pollingService?.isRunning() ?? !!this.webhookHandler;
  }

  /**
   * Check if webhook handling is available
   */
  hasWebhookHandler(): boolean {
    return !!this.webhookHandler;
  }

  /**
   * Check if polling is active
   */
  isPolling(): boolean {
    return this.pollingService?.isRunning() ?? false;
  }

  /**
   * Return the underlying polling service instance, or undefined if not configured.
   */
  getPollingService(): GitHubPollingService | undefined {
    return this.pollingService;
  }
}

/**
 * Create a GitHub service instance
 */
export function createGitHubService(options: GitHubServiceOptions): GitHubService {
  return new GitHubService(options);
}
