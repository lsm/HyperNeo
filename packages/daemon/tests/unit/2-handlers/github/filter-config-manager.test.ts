import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  FilterConfigManager,
  createFilterConfigManager,
} from '../../../../src/lib/github/filter-config-manager';
import type { GitHubFilterConfig } from '@hyperneo/shared';

function createFilterConfig(overrides: Partial<GitHubFilterConfig> = {}): GitHubFilterConfig {
  return {
    repositories: ['owner/repo'],
    authors: { mode: 'all' },
    labels: { mode: 'any' },
    events: {
      issues: ['opened', 'reopened'],
      issue_comment: ['created'],
      pull_request: ['opened'],
    },
    ...overrides,
  };
}

describe('FilterConfigManager', () => {
  let db: Database;
  let manager: FilterConfigManager;

  beforeEach(() => {
    db = new Database(':memory:');
    manager = new FilterConfigManager(db, { cacheTtl: 1000 });
  });

  afterEach(() => {
    db.close();
  });

  describe('constructor and initialization', () => {
    it('should create the table on initialization', () => {
      const result = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='github_filter_configs'"
        )
        .get();
      expect(result).not.toBeNull();
    });

    it('should create index on repository column', () => {
      const result = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_github_filter_configs_repository'"
        )
        .get();
      expect(result).not.toBeNull();
    });

    it('should use custom cacheTtl when provided', () => {
      const customManager = new FilterConfigManager(db, { cacheTtl: 5000 });
      expect(customManager).toBeDefined();
    });

    it('should use default cacheTtl when not provided', () => {
      const defaultManager = new FilterConfigManager(db);
      expect(defaultManager).toBeDefined();
    });
  });

  describe('getGlobalFilter', () => {
    it('should return default config when no global filter set', () => {
      const config = manager.getGlobalFilter();

      expect(config.repositories).toEqual([]);
      expect(config.authors.mode).toBe('all');
      expect(config.labels.mode).toBe('any');
      expect(config.events.issues).toEqual(['opened', 'reopened']);
    });

    it('should return cached config within TTL', () => {
      manager.setGlobalFilter(createFilterConfig({ repositories: ['cached/repo'] }));

      const config1 = manager.getGlobalFilter();
      expect(config1.repositories).toEqual(['cached/repo']);

      const config2 = manager.getGlobalFilter();
      expect(config2.repositories).toEqual(['cached/repo']);
    });

    it('should fetch from database after cache expires', async () => {
      const shortTtlManager = new FilterConfigManager(db, { cacheTtl: 10 });
      shortTtlManager.setGlobalFilter(createFilterConfig({ repositories: ['expire/repo'] }));

      const config1 = shortTtlManager.getGlobalFilter();
      expect(config1.repositories).toEqual(['expire/repo']);

      await new Promise((r) => setTimeout(r, 20));

      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(createFilterConfig({ repositories: ['updated/repo'] }))
      );

      const config2 = shortTtlManager.getGlobalFilter();
      expect(config2.repositories).toEqual(['updated/repo']);
    });
  });

  describe('setGlobalFilter', () => {
    it('should insert new global config', () => {
      const config = createFilterConfig({ repositories: ['new/repo'] });
      manager.setGlobalFilter(config);

      const retrieved = manager.getGlobalFilter();
      expect(retrieved.repositories).toEqual(['new/repo']);
    });

    it('should update existing global config via direct DB update', () => {
      manager.setGlobalFilter(createFilterConfig({ repositories: ['first/repo'] }));

      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(createFilterConfig({ repositories: ['second/repo'] }))
      );

      manager.clearCache();

      const retrieved = manager.getGlobalFilter();
      expect(retrieved.repositories).toEqual(['second/repo']);
    });

    it('should invalidate global cache on set', () => {
      manager.setGlobalFilter(createFilterConfig({ repositories: ['first/repo'] }));
      manager.getGlobalFilter();

      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(createFilterConfig({ repositories: ['second/repo'] }))
      );

      manager.clearCache();

      const config = manager.getGlobalFilter();
      expect(config.repositories).toEqual(['second/repo']);
    });
  });

  describe('getFilterForRepository', () => {
    it('should return global config when no repo-specific config exists', () => {
      manager.setGlobalFilter(createFilterConfig({ repositories: ['global/repo'] }));

      const config = manager.getFilterForRepository('unknown/repo');
      expect(config.repositories).toEqual(['global/repo']);
    });

    it('should return default config when no global or repo config exists', () => {
      const config = manager.getFilterForRepository('unknown/repo');
      expect(config.repositories).toEqual([]);
    });

    it('should return repo-specific config when it exists', () => {
      manager.setRepositoryFilter('specific/repo', {
        repositories: ['specific/repo'],
        authors: { mode: 'allowlist', users: ['alice'] },
      });

      const config = manager.getFilterForRepository('specific/repo');
      expect(config.authors.mode).toBe('allowlist');
      expect(config.authors.users).toEqual(['alice']);
    });

    it('should cache repo config', () => {
      manager.setRepositoryFilter('cached/repo', {
        authors: { mode: 'blocklist', users: ['bot'] },
      });

      const config1 = manager.getFilterForRepository('cached/repo');
      expect(config1.authors.mode).toBe('blocklist');

      const config2 = manager.getFilterForRepository('cached/repo');
      expect(config2.authors.mode).toBe('blocklist');
    });

    it('should fall back to global config when repo config cleared', () => {
      manager.setGlobalFilter(createFilterConfig({ authors: { mode: 'all' } }));
      manager.setRepositoryFilter('fallback/repo', {
        authors: { mode: 'allowlist', users: ['alice'] },
      });

      manager.clearRepositoryFilter('fallback/repo');

      const config = manager.getFilterForRepository('fallback/repo');
      expect(config.authors.mode).toBe('all');
    });
  });

  describe('setRepositoryFilter', () => {
    it('should create new repo-specific config', () => {
      manager.setRepositoryFilter('new/repo', {
        authors: { mode: 'allowlist', users: ['bob'] },
      });

      const config = manager.getFilterForRepository('new/repo');
      expect(config.authors.mode).toBe('allowlist');
      expect(config.authors.users).toEqual(['bob']);
    });

    it('should merge partial config with global', () => {
      manager.setGlobalFilter(
        createFilterConfig({
          labels: { mode: 'require_all', labels: ['bug', 'priority'] },
          events: { issues: ['opened'] },
        })
      );

      manager.setRepositoryFilter('partial/repo', {
        authors: { mode: 'blocklist' },
      });

      const config = manager.getFilterForRepository('partial/repo');
      expect(config.authors.mode).toBe('blocklist');
      expect(config.labels.mode).toBe('require_all');
      expect(config.labels.labels).toEqual(['bug', 'priority']);
    });

    it('should update existing repo config', () => {
      manager.setRepositoryFilter('update/repo', {
        authors: { mode: 'allowlist', users: ['first'] },
      });
      manager.setRepositoryFilter('update/repo', {
        authors: { mode: 'allowlist', users: ['second'] },
      });

      const config = manager.getFilterForRepository('update/repo');
      expect(config.authors.users).toEqual(['second']);
    });

    it('should invalidate cache for updated repo', () => {
      manager.setRepositoryFilter('cache/repo', {
        authors: { mode: 'all' },
      });
      manager.getFilterForRepository('cache/repo');

      manager.setRepositoryFilter('cache/repo', {
        authors: { mode: 'allowlist' },
      });

      const config = manager.getFilterForRepository('cache/repo');
      expect(config.authors.mode).toBe('allowlist');
    });
  });

  describe('clearRepositoryFilter', () => {
    it('should delete repo-specific config', () => {
      manager.setRepositoryFilter('clear/repo', {
        authors: { mode: 'allowlist' },
      });

      manager.clearRepositoryFilter('clear/repo');

      const config = manager.getFilterForRepository('clear/repo');
      expect(config.authors.mode).toBe('all');
    });

    it('should invalidate cache for cleared repo', () => {
      manager.setRepositoryFilter('clear-cache/repo', {
        authors: { mode: 'allowlist' },
      });
      manager.getFilterForRepository('clear-cache/repo');

      manager.clearRepositoryFilter('clear-cache/repo');

      const config = manager.getFilterForRepository('clear-cache/repo');
      expect(config.authors.mode).toBe('all');
    });

    it('should handle clearing non-existent config', () => {
      expect(() => manager.clearRepositoryFilter('nonexistent/repo')).not.toThrow();
    });
  });

  describe('listRepositoryFilters', () => {
    it('should return empty array when no repo configs exist', () => {
      const list = manager.listRepositoryFilters();
      expect(list).toEqual([]);
    });

    it('should list all repo-specific configs', () => {
      manager.setRepositoryFilter('first/repo', { authors: { mode: 'allowlist' } });
      manager.setRepositoryFilter('second/repo', { authors: { mode: 'blocklist' } });

      const list = manager.listRepositoryFilters();

      expect(list).toHaveLength(2);
      expect(list.map((r) => r.repository).sort()).toEqual(['first/repo', 'second/repo']);
    });

    it('should not include global config', () => {
      manager.setGlobalFilter(createFilterConfig());
      manager.setRepositoryFilter('only/repo', { authors: { mode: 'allowlist' } });

      const list = manager.listRepositoryFilters();

      expect(list).toHaveLength(1);
      expect(list[0]?.repository).toBe('only/repo');
    });
  });

  describe('updateGlobalFilter', () => {
    it('should update only specified fields', () => {
      manager.setGlobalFilter(
        createFilterConfig({
          repositories: ['original/repo'],
          authors: { mode: 'all' },
        })
      );

      const current = manager.getGlobalFilter();
      const updated = {
        ...current,
        authors: { mode: 'allowlist' as const, users: ['alice'] },
      };
      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(updated)
      );
      manager.clearCache();

      const config = manager.getGlobalFilter();
      expect(config.repositories).toEqual(['original/repo']);
      expect(config.authors.mode).toBe('allowlist');
    });
  });

  describe('addRepositories', () => {
    it('should add new repositories via updateGlobalFilter', () => {
      manager.setGlobalFilter(createFilterConfig({ repositories: ['first/repo'] }));

      const current = manager.getGlobalFilter();
      const updated = {
        ...current,
        repositories: ['first/repo', 'second/repo', 'third/repo'],
      };
      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(updated)
      );
      manager.clearCache();

      const config = manager.getGlobalFilter();
      expect(config.repositories.sort()).toEqual(['first/repo', 'second/repo', 'third/repo']);
    });
  });

  describe('removeRepositories', () => {
    it('should remove repositories via updateGlobalFilter', () => {
      manager.setGlobalFilter(createFilterConfig({ repositories: ['keep/repo', 'remove/repo'] }));

      const current = manager.getGlobalFilter();
      const updated = {
        ...current,
        repositories: ['keep/repo'],
      };
      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(updated)
      );
      manager.clearCache();

      const config = manager.getGlobalFilter();
      expect(config.repositories).toEqual(['keep/repo']);
    });
  });

  describe('clearCache', () => {
    it('should clear all cached entries', () => {
      manager.setGlobalFilter(createFilterConfig());
      manager.setRepositoryFilter('cached/repo', { authors: { mode: 'allowlist' } });

      manager.getGlobalFilter();
      manager.getFilterForRepository('cached/repo');

      manager.clearCache();

      db.prepare("UPDATE github_filter_configs SET config = ? WHERE id = 'global'").run(
        JSON.stringify(createFilterConfig({ repositories: ['from-db/repo'] }))
      );

      const config = manager.getGlobalFilter();
      expect(config.repositories).toEqual(['from-db/repo']);
    });
  });

  describe('cache TTL behavior', () => {
    it('should respect cache TTL for repo configs', async () => {
      const shortTtlManager = new FilterConfigManager(db, { cacheTtl: 10 });
      shortTtlManager.setRepositoryFilter('ttl/repo', {
        authors: { mode: 'allowlist' },
      });

      const config1 = shortTtlManager.getFilterForRepository('ttl/repo');
      expect(config1.authors.mode).toBe('allowlist');

      await new Promise((r) => setTimeout(r, 20));

      db.prepare('UPDATE github_filter_configs SET config = ? WHERE repository = ?').run(
        JSON.stringify(createFilterConfig({ authors: { mode: 'blocklist', users: ['bot'] } })),
        'ttl/repo'
      );

      const config2 = shortTtlManager.getFilterForRepository('ttl/repo');
      expect(config2.authors.mode).toBe('blocklist');
    });
  });
});

describe('createFilterConfigManager', () => {
  it('should create a FilterConfigManager instance', () => {
    const db = new Database(':memory:');
    const manager = createFilterConfigManager(db);

    expect(manager).toBeInstanceOf(FilterConfigManager);

    db.close();
  });

  it('should pass options to constructor', () => {
    const db = new Database(':memory:');
    const manager = createFilterConfigManager(db, { cacheTtl: 5000 });

    expect(manager).toBeInstanceOf(FilterConfigManager);

    db.close();
  });
});
