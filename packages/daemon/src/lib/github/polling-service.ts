/**
 * GitHub Polling Service
 *
 * Polls GitHub repositories for new issues and comments using ETag caching
 * to minimize API usage and respect rate limits.
 */

import type { GitHubEvent } from '@neokai/shared';
import { Logger } from '../logger';
import { normalizePollingEvent } from './event-normalizer';
import type { GitHubApiComment, GitHubApiIssue, PollingConfig } from './types';

const log = new Logger('github-polling');

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'NeoKai-GitHub-Integration/1.0';

/**
 * State for a single repository being polled
 */
interface RepoState {
  owner: string;
  repo: string;
  lastPollTime: string;
  issuesEtag: string | null;
  commentsEtag: string | null;
}

/**
 * GitHub Polling Service
 *
 * Polls configured repositories for new issues and comments,
 * using ETag caching for efficiency.
 */
export class GitHubPollingService {
  private config: PollingConfig;
  private repositories: Map<string, RepoState> = new Map();
  private running = false;
  private isPolling = false;
  private onEvent?: (event: GitHubEvent) => Promise<void> | void;

  constructor(
    config: Partial<PollingConfig> & { token: string },
    onEvent?: (event: GitHubEvent) => Promise<void> | void
  ) {
    this.config = {
      token: config.token,
      interval: config.interval ?? 60000,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    };
    this.onEvent = onEvent;
  }

  /**
   * Start the polling service (state flag only — scheduling is handled by the job queue).
   */
  start(): void {
    if (this.running) {
      log.warn('Polling service already running');
      return;
    }

    this.running = true;
    log.info('Starting GitHub polling service', {
      repositoryCount: this.repositories.size,
    });
  }

  /**
   * Stop the polling service (state flag only).
   */
  stop(): void {
    if (this.running) {
      this.running = false;
      log.info('GitHub polling service stopped');
    }
  }

  /**
   * Add a repository to poll
   */
  addRepository(owner: string, repo: string): void {
    const key = `${owner}/${repo}`;
    if (this.repositories.has(key)) {
      log.debug('Repository already being polled', { key });
      return;
    }

    this.repositories.set(key, {
      owner,
      repo,
      lastPollTime: new Date(0).toISOString(), // Start from epoch
      issuesEtag: null,
      commentsEtag: null,
    });

    log.info('Added repository to polling', { key });
  }

  /**
   * Remove a repository from polling
   */
  removeRepository(owner: string, repo: string): void {
    const key = `${owner}/${repo}`;
    if (this.repositories.delete(key)) {
      log.info('Removed repository from polling', { key });
    }
  }

  /**
   * Get list of repositories being polled
   */
  getRepositories(): Array<{ owner: string; repo: string }> {
    return Array.from(this.repositories.values()).map((r) => ({
      owner: r.owner,
      repo: r.repo,
    }));
  }

  /**
   * Check if the service is currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Trigger a poll immediately. No-op if a poll is already in progress.
   */
  async triggerPoll(): Promise<void> {
    if (this.isPolling) {
      log.debug('Poll already in progress, skipping triggerPoll');
      return;
    }
    await this.pollAllRepositories();
  }

  /**
   * Poll all configured repositories
   */
  private async pollAllRepositories(): Promise<void> {
    if (this.isPolling) {
      log.debug('Poll already in progress, skipping');
      return;
    }

    this.isPolling = true;

    try {
      const pollPromises = Array.from(this.repositories.values()).map((repo) =>
        this.pollRepository(repo)
      );

      await Promise.allSettled(pollPromises);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll a single repository for new events
   */
  private async pollRepository(state: RepoState): Promise<GitHubEvent[]> {
    const key = `${state.owner}/${state.repo}`;
    const events: GitHubEvent[] = [];

    try {
      // Poll for issues (includes PRs in GitHub API)
      const issuesEvents = await this.pollIssues(state);
      events.push(...issuesEvents);

      // Poll for comments
      const commentsEvents = await this.pollComments(state);
      events.push(...commentsEvents);

      // Update last poll time
      state.lastPollTime = new Date().toISOString();

      log.debug('Repository poll complete', {
        key,
        eventsFound: events.length,
      });
    } catch (error) {
      log.error('Failed to poll repository', {
        key,
        error: error instanceof Error ? error.message : error,
      });
    }

    return events;
  }

  /**
   * Poll the issues endpoint for a repository
   */
  private async pollIssues(state: RepoState): Promise<GitHubEvent[]> {
    const url = `${this.config.baseUrl}/repos/${state.owner}/${state.repo}/issues`;
    const fullName = `${state.owner}/${state.repo}`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.config.token}`,
      'User-Agent': this.config.userAgent ?? DEFAULT_USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // Add ETag for conditional request
    if (state.issuesEtag) {
      headers['If-None-Match'] = state.issuesEtag;
    }

    // Add since parameter for incremental updates
    const since =
      state.lastPollTime !== new Date(0).toISOString() ? `?since=${state.lastPollTime}` : '';

    const response = await fetch(`${url}${since}`, { headers });

    // Handle rate limiting
    this.handleRateLimit(response);

    // 304 Not Modified - no new data
    if (response.status === 304) {
      log.debug('Issues not modified', { fullName });
      return [];
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    // Store new ETag
    const newEtag = response.headers.get('ETag');
    if (newEtag) {
      state.issuesEtag = newEtag;
    }

    const issues = (await response.json()) as GitHubApiIssue[];
    const events: GitHubEvent[] = [];

    for (const issue of issues) {
      // Determine if this is a PR or issue
      const type = issue.pull_request ? 'pull_request' : 'issue';
      const event = normalizePollingEvent(type, issue, fullName);

      if (event && this.onEvent) {
        await this.onEvent(event);
      }

      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Poll the comments endpoint for a repository
   */
  private async pollComments(state: RepoState): Promise<GitHubEvent[]> {
    const url = `${this.config.baseUrl}/repos/${state.owner}/${state.repo}/issues/comments`;
    const fullName = `${state.owner}/${state.repo}`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.config.token}`,
      'User-Agent': this.config.userAgent ?? DEFAULT_USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // Add ETag for conditional request
    if (state.commentsEtag) {
      headers['If-None-Match'] = state.commentsEtag;
    }

    // Add since parameter for incremental updates
    const since =
      state.lastPollTime !== new Date(0).toISOString() ? `?since=${state.lastPollTime}` : '';

    const response = await fetch(`${url}${since}`, { headers });

    // Handle rate limiting
    this.handleRateLimit(response);

    // 304 Not Modified - no new data
    if (response.status === 304) {
      log.debug('Comments not modified', { fullName });
      return [];
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    // Store new ETag
    const newEtag = response.headers.get('ETag');
    if (newEtag) {
      state.commentsEtag = newEtag;
    }

    const comments = (await response.json()) as GitHubApiComment[];
    const events: GitHubEvent[] = [];

    for (const comment of comments) {
      const event = normalizePollingEvent('comment', comment, fullName);

      if (event && this.onEvent) {
        await this.onEvent(event);
      }

      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Handle GitHub API rate limit headers
   */
  private handleRateLimit(response: Response): void {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const reset = response.headers.get('X-RateLimit-Reset');

    if (remaining) {
      const remainingCount = parseInt(remaining, 10);
      if (remainingCount < 100) {
        log.warn('GitHub API rate limit low', {
          remaining: remainingCount,
          resetsAt: reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : 'unknown',
        });
      }
    }

    if (response.status === 403) {
      log.error('GitHub API rate limit exceeded', {
        resetsAt: reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : 'unknown',
      });
    }
  }
}

/**
 * Create a polling service instance
 */
export function createPollingService(
  config: Partial<PollingConfig> & { token: string },
  onEvent?: (event: GitHubEvent) => Promise<void> | void
): GitHubPollingService {
  return new GitHubPollingService(config, onEvent);
}
