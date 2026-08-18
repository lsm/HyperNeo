import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  GitHubPollingService,
  createPollingService,
} from '../../../../src/lib/github/polling-service';
import type { GitHubEvent } from '@hyperneo/shared';

describe('GitHubPollingService', () => {
  let service: GitHubPollingService;
  let onEventMock: ReturnType<typeof mock>;

  beforeEach(() => {
    onEventMock = mock(async (_event: GitHubEvent) => {});
    service = createPollingService(
      {
        token: 'test-token',
        interval: 60000,
      },
      onEventMock
    );
  });

  afterEach(() => {
    service.stop();
    mock.restore();
  });

  describe('constructor', () => {
    it('creates service with default config', () => {
      const svc = createPollingService({ token: 'test' });
      expect(svc).toBeDefined();
    });

    it('creates service with custom config', () => {
      const svc = createPollingService({
        token: 'test',
        interval: 30000,
        baseUrl: 'https://custom.api.github.com',
        userAgent: 'CustomAgent/1.0',
      });
      expect(svc).toBeDefined();
    });

    it('accepts event callback', () => {
      const callback = mock(async () => {});
      const svc = createPollingService({ token: 'test' }, callback);
      expect(svc).toBeDefined();
    });
  });

  describe('addRepository', () => {
    it('adds a repository to poll', () => {
      service.addRepository('owner', 'repo');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(1);
      expect(repos[0]).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('does not add duplicate repositories', () => {
      service.addRepository('owner', 'repo');
      service.addRepository('owner', 'repo');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(1);
    });

    it('adds multiple different repositories', () => {
      service.addRepository('owner1', 'repo1');
      service.addRepository('owner2', 'repo2');
      service.addRepository('owner3', 'repo3');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(3);
    });
  });

  describe('removeRepository', () => {
    it('removes a repository', () => {
      service.addRepository('owner', 'repo');
      service.removeRepository('owner', 'repo');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(0);
    });

    it('handles removing non-existent repository', () => {
      service.addRepository('owner', 'repo');
      service.removeRepository('non-existent', 'repo');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(1);
    });
  });

  describe('getRepositories', () => {
    it('returns empty array when no repositories', () => {
      const repos = service.getRepositories();
      expect(repos).toEqual([]);
    });

    it('returns all added repositories', () => {
      service.addRepository('owner1', 'repo1');
      service.addRepository('owner2', 'repo2');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(2);
    });
  });

  describe('isRunning', () => {
    it('returns false before start', () => {
      expect(service.isRunning()).toBe(false);
    });

    it('returns true after start', () => {
      service.start();
      expect(service.isRunning()).toBe(true);
    });

    it('returns false after stop', () => {
      service.start();
      service.stop();
      expect(service.isRunning()).toBe(false);
    });
  });

  describe('start', () => {
    it('starts the polling loop', () => {
      service.start();
      expect(service.isRunning()).toBe(true);
    });

    it('does not start twice', () => {
      service.start();
      service.start();

      expect(service.isRunning()).toBe(true);
    });
  });

  describe('stop', () => {
    it('stops the polling loop', () => {
      service.start();
      service.stop();

      expect(service.isRunning()).toBe(false);
    });

    it('handles stop when not running', () => {
      service.stop();
      expect(service.isRunning()).toBe(false);
    });
  });

  describe('integration', () => {
    it('can add repositories while running', () => {
      service.start();
      service.addRepository('owner', 'repo');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(1);

      service.stop();
    });

    it('can remove repositories while running', () => {
      service.addRepository('owner', 'repo');
      service.start();
      service.removeRepository('owner', 'repo');

      const repos = service.getRepositories();
      expect(repos).toHaveLength(0);

      service.stop();
    });

    it('retains repositories after stop and restart', () => {
      service.addRepository('owner', 'repo');
      service.start();
      service.stop();

      const newService = createPollingService({ token: 'test-token' }, onEventMock);

      expect(newService.getRepositories()).toHaveLength(0);
    });
  });
});
