import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { RouterAgent, type RoomCandidate } from '../../../../src/lib/github/router-agent';
import type { GitHubEvent, SecurityCheckResult, RoutingResult } from '@hyperneo/shared';

function createTestEvent(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    id: 'test-event-id',
    source: 'webhook',
    eventType: 'issues',
    action: 'opened',
    repository: {
      owner: 'testowner',
      repo: 'testrepo',
      fullName: 'testowner/testrepo',
    },
    issue: {
      number: 1,
      title: 'Test Issue',
      body: 'Test body content for the issue.',
      labels: ['bug'],
    },
    sender: {
      login: 'testuser',
      type: 'User',
    },
    rawPayload: {},
    receivedAt: Date.now(),
    ...overrides,
  };
}

function createRoomCandidate(overrides: Partial<RoomCandidate> = {}): RoomCandidate {
  return {
    roomId: 'room-1',
    roomName: 'Test Room',
    repositories: ['testowner/testrepo'],
    priority: 1,
    ...overrides,
  };
}

function createSecurityResult(overrides: Partial<SecurityCheckResult> = {}): SecurityCheckResult {
  return {
    passed: true,
    injectionRisk: 'none',
    ...overrides,
  };
}

describe('RouterAgent', () => {
  describe('Security-First Rejection', () => {
    test('should reject events that failed security check', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult({
        passed: false,
        injectionRisk: 'high',
        reason: 'High-risk injection patterns detected',
      });

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('reject');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('Security check failed');
      expect(result.securityCheck).toEqual(securityResult);
    });

    test('should reject even with high-risk patterns', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult({
        passed: false,
        injectionRisk: 'high',
        reason: 'Prompt injection detected',
      });

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('reject');
    });

    test('should reject with medium-risk security failure', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult({
        passed: false,
        injectionRisk: 'medium',
        reason: 'Suspicious patterns detected',
      });

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('reject');
    });
  });

  describe('Quick Routing - No Candidates', () => {
    test('should route to inbox when no room mappings exist', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates: RoomCandidate[] = [];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('inbox');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('No room mappings');
      expect(result.roomId).toBeUndefined();
    });
  });

  describe('Quick Routing - Single Candidate', () => {
    test('should route directly with single exact repository match', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [
        createRoomCandidate({
          roomId: 'bugs-room',
          roomName: 'Bug Reports',
          repositories: ['testowner/testrepo'],
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
      expect(result.roomId).toBe('bugs-room');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('Direct repository match');
    });

    test('should route with case-insensitive repository match', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        repository: {
          owner: 'TestOwner',
          repo: 'TestRepo',
          fullName: 'TestOwner/TestRepo',
        },
      });
      const candidates = [
        createRoomCandidate({
          repositories: ['testowner/testrepo'],
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });
  });

  describe('Quick Routing - Multiple Candidates with Priority', () => {
    test('should route to highest priority room when multiple matches exist', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [
        createRoomCandidate({
          roomId: 'low-priority-room',
          roomName: 'Low Priority',
          repositories: ['testowner/testrepo'],
          priority: 1,
        }),
        createRoomCandidate({
          roomId: 'high-priority-room',
          roomName: 'High Priority',
          repositories: ['testowner/testrepo'],
          priority: 10,
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
      expect(result.roomId).toBe('high-priority-room');
      expect(result.confidence).toBe('high');
    });

    test('should use priority to disambiguate multiple rooms', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [
        createRoomCandidate({
          roomId: 'room-a',
          priority: 5,
        }),
        createRoomCandidate({
          roomId: 'room-b',
          priority: 3,
        }),
        createRoomCandidate({
          roomId: 'room-c',
          priority: 8,
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.roomId).toBe('room-c');
    });
  });

  describe('Quick Routing - Wildcard Matches', () => {
    test('should route with single wildcard match', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        repository: {
          owner: 'myorg',
          repo: 'any-repo',
          fullName: 'myorg/any-repo',
        },
      });
      const candidates = [
        createRoomCandidate({
          roomId: 'org-room',
          roomName: 'All Org Repos',
          repositories: ['myorg/*'],
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
      expect(result.roomId).toBe('org-room');
      expect(result.confidence).toBe('medium');
    });
  });

  describe('Quick Routing - No Direct Match', () => {
    test('should route to inbox when no repository match found', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        repository: {
          owner: 'unknown',
          repo: 'repo',
          fullName: 'unknown/repo',
        },
      });
      const candidates = [
        createRoomCandidate({
          repositories: ['other/repo'],
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('inbox');
      expect(result.confidence).toBe('medium');
      expect(result.reason).toContain('No direct repository match');
    });
  });

  describe('Security Result Passthrough', () => {
    test('should include security result in routing result', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult({
        passed: true,
        injectionRisk: 'low',
        reason: 'Minor suspicious patterns',
      });

      const result = await agent.route(event, candidates, securityResult);

      expect(result.securityCheck).toEqual(securityResult);
    });
  });

  describe('Event Context in Routing', () => {
    test('should route issue events', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        eventType: 'issues',
        action: 'opened',
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });

    test('should route comment events', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        eventType: 'issue_comment',
        action: 'created',
        comment: {
          id: 'comment-1',
          body: 'This is a comment',
        },
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });

    test('should route PR events', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        eventType: 'pull_request',
        action: 'opened',
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });
  });

  describe('Room Candidate Variations', () => {
    test('should route to room with description', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [
        createRoomCandidate({
          roomId: 'described-room',
          roomName: 'Bug Reports',
          roomDescription: 'Room for handling bug reports from users',
          repositories: ['testowner/testrepo'],
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
      expect(result.roomId).toBe('described-room');
    });

    test('should handle room with multiple repositories', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent();
      const candidates = [
        createRoomCandidate({
          roomId: 'multi-repo-room',
          repositories: ['owner/repo1', 'testowner/testrepo', 'owner/repo2'],
        }),
      ];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });
  });

  describe('Configuration Options', () => {
    test('should use custom model', () => {
      const agent = new RouterAgent({
        apiKey: 'test-key',
        model: 'claude-3-opus-latest',
      });

      expect(agent).toBeDefined();
    });

    test('should use custom timeout', () => {
      const agent = new RouterAgent({
        apiKey: 'test-key',
        timeout: 20000,
      });

      expect(agent).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    test('should handle event without issue data', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        issue: undefined,
        comment: {
          id: 'comment-1',
          body: 'Test comment',
        },
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });

    test('should handle event with empty labels', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: 'Body',
          labels: [],
        },
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });

    test('should handle event with long body', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const longBody = 'A'.repeat(1000);
      const event = createTestEvent({
        issue: {
          number: 1,
          title: 'Test',
          body: longBody,
          labels: ['bug'],
        },
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });

    test('should handle bot sender', async () => {
      const agent = new RouterAgent({ apiKey: 'test-key' });
      const event = createTestEvent({
        sender: {
          login: 'dependabot[bot]',
          type: 'Bot',
        },
      });
      const candidates = [createRoomCandidate()];
      const securityResult = createSecurityResult();

      const result = await agent.route(event, candidates, securityResult);

      expect(result.decision).toBe('route');
    });
  });
});
