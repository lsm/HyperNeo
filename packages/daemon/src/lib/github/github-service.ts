import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { MAX_GITHUB_POLLING_INTERVAL_SECONDS } from '@hyperneo/shared';
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

export interface GitHubServiceOptions {
  db: Database;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  config: Config;
  apiKey: string;
  apiKeyType?: 'api_key' | 'oauth';
  githubToken?: string;
  jobQueue?: JobQueueRepository;
  jobProcessor?: JobQueueProcessor;
  getPollingIntervalSeconds?: () => number | undefined;
}

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

    this.filterConfigManager = createFilterConfigManager(this.db.getDatabase());

    const filterOptions: GitHubEventFilterOptions = {
      githubToken: this.githubToken,
      configManager: this.filterConfigManager,
    };
    this.eventFilter = createEventFilter(this.filterConfigManager.getGlobalFilter(), filterOptions);

    this.securityAgent = createSecurityAgent({
      apiKey: this.apiKey,
      apiKeyType: this.apiKeyType,
    });

    this.routerAgent = createRouterAgent({
      apiKey: this.apiKey,
      apiKeyType: this.apiKeyType,
    });

    this.inboxManager = new InboxManager(this.db);

    log.info('GitHubService initialized', {
      hasWebhookSecret: !!this.config.githubWebhookSecret,
      pollingInterval: this.getPollingIntervalSecondsValue(),
      hasApiKey: !!this.apiKey,
    });
  }

  start(): void {
    if (this.config.githubWebhookSecret) {
      this.webhookHandler = createWebhookHandler(this.config.githubWebhookSecret, async (event) => {
        await this.processEvent(event);
      });
      log.info('Webhook handler initialized');
    }

    this.refreshPolling();

    log.info('GitHub service started');
  }

  refreshPolling(options: { reschedulePending?: boolean } = {}): void {
    const intervalSeconds = this.getPollingIntervalSecondsValue();

    if (intervalSeconds <= 0 || !this.githubToken) {
      this.deletePendingPollJobs();
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
            intervalMs: () => this.getPollingIntervalSecondsValue() * 1000,
          })
        );
        this.pollJobHandlerRegistered = true;
        log.info('github.poll job handler registered');
      }

      if (options.reschedulePending) {
        this.deletePendingPollJobs();
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
    return Math.min(MAX_GITHUB_POLLING_INTERVAL_SECONDS, Math.max(0, Math.trunc(configured)));
  }

  private deletePendingPollJobs(): void {
    if (!this.jobQueue) return;
    for (const job of this.jobQueue.listJobs({ queue: GITHUB_POLL, status: 'pending' })) {
      this.jobQueue.deleteJob(job.id);
    }
  }

  stop(): void {
    if (this.pollingService) {
      this.pollingService.stop();
      this.pollingService = undefined;
    }

    this.webhookHandler = undefined;

    log.info('GitHub service stopped');
  }

  async handleWebhook(req: Request): Promise<Response> {
    if (!this.webhookHandler) {
      return new Response(JSON.stringify({ error: 'Webhook handler not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return this.webhookHandler(req);
  }

  async processEvent(event: GitHubEvent): Promise<RoutingResult> {
    log.debug('Processing GitHub event', {
      eventId: event.id,
      eventType: event.eventType,
      action: event.action,
      repository: event.repository.fullName,
    });

    this.emitEvent('github.eventReceived', {
      sessionId: 'global',
      event,
    });

    try {
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

      const candidates = this.findCandidates(event);
      log.debug('Found candidate rooms', {
        eventId: event.id,
        candidateCount: candidates.length,
      });

      const routingResult = await this.routeEvent(event, candidates, securityResult);

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

  private async filterEvent(event: GitHubEvent): Promise<FilterResult> {
    return this.eventFilter.filter(event);
  }

  private async checkSecurity(event: GitHubEvent): Promise<SecurityCheckResult> {
    const content = event.comment?.body ?? event.issue?.body ?? '';
    const title = event.issue?.title;

    return this.securityAgent.check(content, {
      title,
      author: event.sender.login,
    });
  }

  private findCandidates(event: GitHubEvent): RoomCandidate[] {
    const mappings = this.db.listGitHubMappingsForRepository(
      event.repository.owner,
      event.repository.repo
    );

    const candidates: RoomCandidate[] = [];

    for (const mapping of mappings) {
      if (this.mappingMatchesEvent(mapping, event)) {
        candidates.push({
          roomId: mapping.roomId,
          roomName: mapping.roomId,
          repositories: mapping.repositories.map((r) => `${r.owner}/${r.repo}`),
          priority: mapping.priority,
        });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);

    return candidates;
  }

  private mappingMatchesEvent(mapping: RoomGitHubMapping, event: GitHubEvent): boolean {
    for (const repoMapping of mapping.repositories) {
      if (
        repoMapping.owner !== event.repository.owner ||
        repoMapping.repo !== event.repository.repo
      ) {
        continue;
      }

      if (repoMapping.issueNumbers && repoMapping.issueNumbers.length > 0) {
        if (!event.issue || !repoMapping.issueNumbers.includes(event.issue.number)) {
          continue;
        }
      }

      if (repoMapping.labels && repoMapping.labels.length > 0) {
        const eventLabels = event.issue?.labels ?? [];
        if (!repoMapping.labels.some((label) => eventLabels.includes(label))) {
          continue;
        }
      }

      return true;
    }

    return false;
  }

  private async routeEvent(
    event: GitHubEvent,
    candidates: RoomCandidate[],
    securityResult: SecurityCheckResult
  ): Promise<RoutingResult> {
    return this.routerAgent.route(event, candidates, securityResult);
  }

  private deliverToRoom(event: GitHubEvent, roomId: string): void {
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

  private addToInbox(event: GitHubEvent, security: SecurityCheckResult, reason: string): InboxItem {
    return this.inboxManager.addToInbox(event, security, reason);
  }

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

  private emitEvent<K extends keyof DaemonInternalEventMap & string>(
    event: K,
    data: DaemonInternalEventMap[K]
  ): void {
    try {
      this.internalEventBus.publishAsync(
        event,
        data as DaemonInternalEventMap[K] & { sessionId: string } & Record<string, unknown>
      );
    } catch {}
  }

  addRepository(owner: string, repo: string): void {
    if (this.pollingService) {
      this.pollingService.addRepository(owner, repo);
    }

    this.filterConfigManager.addRepositories([`${owner}/${repo}`]);

    log.info('Repository added', { owner, repo });
  }

  removeRepository(owner: string, repo: string): void {
    if (this.pollingService) {
      this.pollingService.removeRepository(owner, repo);
    }

    this.filterConfigManager.removeRepositories([`${owner}/${repo}`]);

    log.info('Repository removed', { owner, repo });
  }

  getPolledRepositories(): Array<{ owner: string; repo: string }> {
    if (!this.pollingService) {
      return [];
    }
    return this.pollingService.getRepositories();
  }

  getInboxManager(): InboxManager {
    return this.inboxManager;
  }

  getPendingInboxCount(): number {
    return this.inboxManager.countByStatus().pending;
  }

  getFilterConfigManager(): FilterConfigManager {
    return this.filterConfigManager;
  }

  isRunning(): boolean {
    return this.pollingService?.isRunning() ?? !!this.webhookHandler;
  }

  hasWebhookHandler(): boolean {
    return !!this.webhookHandler;
  }

  isPolling(): boolean {
    return this.pollingService?.isRunning() ?? false;
  }

  getPollingService(): GitHubPollingService | undefined {
    return this.pollingService;
  }
}

export function createGitHubService(options: GitHubServiceOptions): GitHubService {
  return new GitHubService(options);
}
