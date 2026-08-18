import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import type {
  GitHubFilterConfig,
  GitHubAuthorFilter,
  GitHubLabelFilter,
  GitHubEventFilter,
} from '@hyperneo/shared';
import { Logger } from '../logger';

const log = new Logger('github-filter-config');

interface ConfigCacheEntry {
  config: GitHubFilterConfig;
  cachedAt: number;
}

const DEFAULT_FILTER_CONFIG: GitHubFilterConfig = {
  repositories: [],
  authors: {
    mode: 'all',
  },
  labels: {
    mode: 'any',
  },
  events: {
    issues: ['opened', 'reopened'],
    issue_comment: ['created'],
    pull_request: ['opened'],
  },
};

export class FilterConfigManager {
  private db: BunDatabase;
  private cache: Map<string, ConfigCacheEntry> = new Map();
  private cacheTtl: number;

  private static readonly DEFAULT_CACHE_TTL = 60 * 1000;

  constructor(db: BunDatabase, options?: { cacheTtl?: number }) {
    this.db = db;
    this.cacheTtl = options?.cacheTtl ?? FilterConfigManager.DEFAULT_CACHE_TTL;
    this.initializeTable();
    log.debug('FilterConfigManager initialized', { cacheTtl: this.cacheTtl });
  }

  private initializeTable(): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS github_filter_configs (
          id TEXT PRIMARY KEY,
          repository TEXT UNIQUE,
          config TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`
      )
      .run();

    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_github_filter_configs_repository
         ON github_filter_configs(repository)`
      )
      .run();
  }

  getFilterForRepository(repository: string): GitHubFilterConfig {
    const cacheKey = `repo:${repository}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      log.debug('Filter config cache hit', { repository });
      return cached.config;
    }

    const repoConfig = this.getRepositoryConfig(repository);
    if (repoConfig) {
      this.cache.set(cacheKey, { config: repoConfig, cachedAt: Date.now() });
      return repoConfig;
    }

    const globalConfig = this.getGlobalFilter();
    this.cache.set(cacheKey, { config: globalConfig, cachedAt: Date.now() });
    return globalConfig;
  }

  getGlobalFilter(): GitHubFilterConfig {
    const cacheKey = 'global';
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      return cached.config;
    }

    const stmt = this.db.prepare(
      `SELECT config FROM github_filter_configs WHERE repository IS NULL`
    );
    const row = stmt.get() as Record<string, unknown> | undefined;

    if (row) {
      const config = JSON.parse(row.config as string) as GitHubFilterConfig;
      this.cache.set(cacheKey, { config, cachedAt: Date.now() });
      return config;
    }

    this.cache.set(cacheKey, { config: DEFAULT_FILTER_CONFIG, cachedAt: Date.now() });
    return DEFAULT_FILTER_CONFIG;
  }

  setGlobalFilter(config: GitHubFilterConfig): void {
    const now = Date.now();
    const configJson = JSON.stringify(config);

    const stmt = this.db.prepare(
      `INSERT INTO github_filter_configs (id, repository, config, created_at, updated_at)
       VALUES ('global', NULL, ?, ?, ?)
       ON CONFLICT(repository) DO UPDATE SET config = ?, updated_at = ?`
    );

    stmt.run(configJson, now, now, configJson, now);

    this.cache.delete('global');
    this.invalidateRepoCaches();

    log.info('Global filter config updated');
  }

  setRepositoryFilter(repository: string, config: Partial<GitHubFilterConfig>): void {
    const globalConfig = this.getGlobalFilter();
    const mergedConfig: GitHubFilterConfig = {
      repositories: config.repositories ?? globalConfig.repositories,
      authors: config.authors ?? globalConfig.authors,
      labels: config.labels ?? globalConfig.labels,
      events: config.events ?? globalConfig.events,
    };

    const now = Date.now();
    const configJson = JSON.stringify(mergedConfig);
    const id = `repo:${repository}`;

    const stmt = this.db.prepare(
      `INSERT INTO github_filter_configs (id, repository, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repository) DO UPDATE SET config = ?, updated_at = ?`
    );

    stmt.run(id, repository, configJson, now, now, configJson, now);

    this.cache.delete(`repo:${repository}`);

    log.info('Repository filter config set', { repository });
  }

  clearRepositoryFilter(repository: string): void {
    const stmt = this.db.prepare(`DELETE FROM github_filter_configs WHERE repository = ?`);
    const result = stmt.run(repository);

    this.cache.delete(`repo:${repository}`);

    if (result.changes > 0) {
      log.info('Repository filter config cleared', { repository });
    }
  }

  listRepositoryFilters(): Array<{ repository: string; config: GitHubFilterConfig }> {
    const stmt = this.db.prepare(
      `SELECT repository, config FROM github_filter_configs WHERE repository IS NOT NULL`
    );
    const rows = stmt.all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      repository: row.repository as string,
      config: JSON.parse(row.config as string) as GitHubFilterConfig,
    }));
  }

  updateGlobalFilter(updates: {
    repositories?: string[];
    authors?: Partial<GitHubAuthorFilter>;
    labels?: Partial<GitHubLabelFilter>;
    events?: Partial<GitHubEventFilter>;
  }): void {
    const current = this.getGlobalFilter();

    const updated: GitHubFilterConfig = {
      repositories: updates.repositories ?? current.repositories,
      authors: updates.authors ? { ...current.authors, ...updates.authors } : current.authors,
      labels: updates.labels ? { ...current.labels, ...updates.labels } : current.labels,
      events: updates.events ? { ...current.events, ...updates.events } : current.events,
    };

    this.setGlobalFilter(updated);
  }

  addRepositories(repositories: string[]): void {
    const current = this.getGlobalFilter();
    const newRepos = new Set([...current.repositories, ...repositories]);
    this.updateGlobalFilter({ repositories: Array.from(newRepos) });
  }

  removeRepositories(repositories: string[]): void {
    const current = this.getGlobalFilter();
    const removeSet = new Set(repositories);
    const filtered = current.repositories.filter((r) => !removeSet.has(r));
    this.updateGlobalFilter({ repositories: filtered });
  }

  clearCache(): void {
    this.cache.clear();
    log.debug('Filter config cache cleared');
  }

  private getRepositoryConfig(repository: string): GitHubFilterConfig | null {
    const stmt = this.db.prepare(`SELECT config FROM github_filter_configs WHERE repository = ?`);
    const row = stmt.get(repository) as Record<string, unknown> | undefined;

    if (!row) return null;
    return JSON.parse(row.config as string) as GitHubFilterConfig;
  }

  private invalidateRepoCaches(): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith('repo:')) {
        this.cache.delete(key);
      }
    }
  }
}

export function createFilterConfigManager(
  db: BunDatabase,
  options?: { cacheTtl?: number }
): FilterConfigManager {
  return new FilterConfigManager(db, options);
}
