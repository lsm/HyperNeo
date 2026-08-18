import type { GitHubEvent, GitHubFilterConfig, FilterResult } from '@hyperneo/shared';
import { Logger } from '../logger';
import type { FilterConfigManager } from './filter-config-manager';

const log = new Logger('github-event-filter');

const GITHUB_API_BASE = 'https://api.github.com';

const PERMISSION_LEVELS: Record<string, number> = {
  none: 0,
  read: 1,
  write: 2,
  maintain: 3,
  admin: 4,
};

interface PermissionCacheEntry {
  permission: string | null;
  cachedAt: number;
}

export interface GitHubEventFilterOptions {
  githubToken?: string;
  cacheTtl?: number;
  configManager?: FilterConfigManager;
}

export class GitHubEventFilter {
  private config: GitHubFilterConfig;
  private configManager?: FilterConfigManager;
  private githubToken?: string;
  private permissionCache: Map<string, PermissionCacheEntry> = new Map();
  private cacheTtl: number;

  private static readonly DEFAULT_CACHE_TTL = 5 * 60 * 1000;

  constructor(config: GitHubFilterConfig, options?: GitHubEventFilterOptions) {
    this.config = config;
    this.configManager = options?.configManager;
    this.githubToken = options?.githubToken;
    this.cacheTtl = options?.cacheTtl ?? GitHubEventFilter.DEFAULT_CACHE_TTL;
    log.debug('GitHubEventFilter initialized', {
      hasToken: !!this.githubToken,
      cacheTtl: this.cacheTtl,
      hasConfigManager: !!this.configManager,
    });
  }

  setConfig(config: GitHubFilterConfig): void {
    this.config = config;
    log.debug('Filter config updated');
  }

  async filter(event: GitHubEvent): Promise<FilterResult> {
    log.debug('Filtering event', {
      eventId: event.id,
      eventType: event.eventType,
      action: event.action,
      repository: event.repository.fullName,
      sender: event.sender.login,
    });

    const effectiveConfig = this.getEffectiveConfig(event.repository.fullName);

    if (!this.checkRepository(event, effectiveConfig)) {
      return {
        passed: false,
        reason: `Repository ${event.repository.fullName} not in allowlist`,
      };
    }

    if (!this.checkEventType(event, effectiveConfig)) {
      return {
        passed: false,
        reason: `Event type ${event.eventType}.${event.action} not in allowed actions`,
      };
    }

    const authorResult = await this.checkAuthor(event, effectiveConfig);
    if (!authorResult.passed) {
      return authorResult;
    }

    if (!this.checkLabels(event, effectiveConfig)) {
      return {
        passed: false,
        reason: 'Event labels do not match required filter',
      };
    }

    log.debug('Event passed all filters', { eventId: event.id });
    return { passed: true };
  }

  private getEffectiveConfig(repository: string): GitHubFilterConfig {
    if (this.configManager) {
      return this.configManager.getFilterForRepository(repository);
    }
    return this.config;
  }

  setGitHubToken(token: string): void {
    this.githubToken = token;
  }

  clearCache(): void {
    this.permissionCache.clear();
    log.debug('Permission cache cleared');
  }

  private checkRepository(event: GitHubEvent, config: GitHubFilterConfig): boolean {
    const fullName = event.repository.fullName;
    const owner = event.repository.owner;
    const repositories = config.repositories;

    for (const repo of repositories) {
      if (repo === fullName) {
        return true;
      }
      if (repo === `${owner}/*`) {
        return true;
      }
    }

    return false;
  }

  private checkEventType(event: GitHubEvent, config: GitHubFilterConfig): boolean {
    const eventFilter = config.events;
    const { eventType, action } = event;

    let allowedActions: string[] | undefined;
    if (eventType === 'issues') {
      allowedActions = eventFilter.issues;
    } else if (eventType === 'issue_comment') {
      allowedActions = eventFilter.issue_comment;
    } else if (eventType === 'pull_request') {
      allowedActions = eventFilter.pull_request;
    }

    if (!allowedActions) {
      return true;
    }

    return allowedActions.includes(action as never);
  }

  private async checkAuthor(event: GitHubEvent, config: GitHubFilterConfig): Promise<FilterResult> {
    const authorFilter = config.authors;
    const sender = event.sender;

    if (authorFilter.mode === 'all') {
      if (authorFilter.minPermission && this.githubToken) {
        const permission = await this.checkUserPermission(
          event.repository.owner,
          event.repository.repo,
          sender.login
        );
        if (permission && !this.hasMinPermission(permission, authorFilter.minPermission)) {
          return {
            passed: false,
            reason: `User ${sender.login} has permission ${permission}, requires ${authorFilter.minPermission}`,
          };
        }
      }
      return { passed: true };
    }

    if (sender.type === 'Bot') {
      if (authorFilter.mode === 'blocklist') {
        const blockedUsers = authorFilter.users ?? [];
        if (blockedUsers.includes(sender.login)) {
          return {
            passed: false,
            reason: `Bot ${sender.login} is in blocklist`,
          };
        }
      }
      return { passed: true };
    }

    if (authorFilter.mode === 'allowlist') {
      const allowedUsers = authorFilter.users ?? [];

      const userAllowed = allowedUsers.includes(sender.login);

      const teamAllowed = false;

      if (!userAllowed && !teamAllowed) {
        return {
          passed: false,
          reason: `User ${sender.login} not in allowlist`,
        };
      }
    }

    if (authorFilter.mode === 'blocklist') {
      const blockedUsers = authorFilter.users ?? [];

      if (blockedUsers.includes(sender.login)) {
        return {
          passed: false,
          reason: `User ${sender.login} is in blocklist`,
        };
      }
    }

    if (authorFilter.minPermission && this.githubToken) {
      const permission = await this.checkUserPermission(
        event.repository.owner,
        event.repository.repo,
        sender.login
      );

      if (permission && !this.hasMinPermission(permission, authorFilter.minPermission)) {
        return {
          passed: false,
          reason: `User ${sender.login} has permission ${permission}, requires ${authorFilter.minPermission}`,
        };
      }
    }

    return { passed: true };
  }

  private checkLabels(event: GitHubEvent, config: GitHubFilterConfig): boolean {
    const labelFilter = config.labels;
    const eventLabels = event.issue?.labels ?? [];

    if (labelFilter.mode === 'any') {
      return true;
    }

    if (labelFilter.mode === 'require_any') {
      const requiredLabels = labelFilter.labels ?? [];
      if (requiredLabels.length === 0) {
        return true;
      }
      return eventLabels.some((label) => requiredLabels.includes(label));
    }

    if (labelFilter.mode === 'require_all') {
      const requiredLabels = labelFilter.labels ?? [];
      if (requiredLabels.length === 0) {
        return true;
      }
      return requiredLabels.every((label) => eventLabels.includes(label));
    }

    if (labelFilter.mode === 'exclude') {
      const excludedLabels = labelFilter.labels ?? [];
      return !eventLabels.some((label) => excludedLabels.includes(label));
    }

    return true;
  }

  private async checkUserPermission(
    owner: string,
    repo: string,
    username: string
  ): Promise<string | null> {
    const cacheKey = `${owner}/${repo}:${username}`;

    const cached = this.permissionCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      log.debug('Permission cache hit', { cacheKey, permission: cached.permission });
      return cached.permission;
    }

    if (!this.githubToken) {
      log.debug('No GitHub token, skipping permission check');
      return null;
    }

    try {
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/collaborators/${username}/permission`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.githubToken}`,
            'User-Agent': 'HyperNeo-GitHub-Integration/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (response.status === 403) {
        const remaining = response.headers.get('X-RateLimit-Remaining');
        const reset = response.headers.get('X-RateLimit-Reset');
        log.warn('GitHub API rate limit hit during permission check', {
          remaining,
          resetsAt: reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : 'unknown',
        });
        return null;
      }

      if (response.status === 404) {
        this.cachePermission(cacheKey, null);
        return null;
      }

      if (!response.ok) {
        log.warn('Failed to check user permission', {
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const data = (await response.json()) as { permission?: string };
      const permission = data.permission ?? null;

      this.cachePermission(cacheKey, permission);
      log.debug('Permission check successful', { cacheKey, permission });

      return permission;
    } catch (error) {
      log.error('Error checking user permission', {
        cacheKey,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private cachePermission(cacheKey: string, permission: string | null): void {
    this.permissionCache.set(cacheKey, {
      permission,
      cachedAt: Date.now(),
    });
  }

  private hasMinPermission(
    actual: string,
    required: 'admin' | 'maintain' | 'write' | 'read' | 'none'
  ): boolean {
    const actualLevel = PERMISSION_LEVELS[actual] ?? 0;
    const requiredLevel = PERMISSION_LEVELS[required] ?? 0;
    return actualLevel >= requiredLevel;
  }
}

export function createEventFilter(
  config: GitHubFilterConfig,
  options?: GitHubEventFilterOptions
): GitHubEventFilter {
  return new GitHubEventFilter(config, options);
}
