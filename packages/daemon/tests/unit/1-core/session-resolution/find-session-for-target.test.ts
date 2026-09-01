import { describe, expect, test } from 'bun:test';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import { findSessionForTarget } from '../../../../src/lib/session-resolution/find-session-for-target';
import type { FindTarget } from '../../../../src/lib/session-resolution/target';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import { coordinatorSessionId } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

interface DepsLog {
  getSession: string[];
  rehydrateSubSession: string[];
  ensureLongTermAgent: Array<[spaceId: string, agentId: string]>;
  activateTaskAgent: number;
  spawnPostApprovalWorker: number;
}

function makeDeps(
  handlers: {
    getSession?: (sessionId: string) => unknown;
    rehydrateSubSession?: (sessionId: string) => unknown;
    getCoordinator?: () => { id: string } | null;
  } = {}
): { deps: SessionResolutionDeps; log: DepsLog } {
  const log: DepsLog = {
    getSession: [],
    rehydrateSubSession: [],
    ensureLongTermAgent: [],
    activateTaskAgent: 0,
    spawnPostApprovalWorker: 0,
  };
  const deps: SessionResolutionDeps = {
    getSession: async (sessionId) => {
      log.getSession.push(sessionId);
      return handlers.getSession ? handlers.getSession(sessionId) : null;
    },
    rehydrateSubSession: async (sessionId) => {
      log.rehydrateSubSession.push(sessionId);
      return handlers.rehydrateSubSession ? handlers.rehydrateSubSession(sessionId) : null;
    },
    getCoordinator: async () => (handlers.getCoordinator ? handlers.getCoordinator() : null),
    ensureLongTermAgent: async (spaceId, agentId) => {
      log.ensureLongTermAgent.push([spaceId, agentId]);
      return null;
    },
    listWorkerExecutions: () => [],
    activateTaskAgent: async () => {
      log.activateTaskAgent += 1;
      return false;
    },
    spawnPostApprovalWorker: async () => {
      log.spawnPostApprovalWorker += 1;
      return null;
    },
  };
  return { deps, log };
}

describe('findSessionForTarget', () => {
  describe('session kind', () => {
    test('direct getSession hit resolves without rehydrating or creating', async () => {
      const { deps, log } = makeDeps({ getSession: () => ({ id: 'sess-1' }) });
      const target: FindTarget = { kind: 'session', sessionId: 'sess-1' };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'resolved',
        sessionId: 'sess-1',
        created: false,
      });
      expect(log.getSession).toEqual(['sess-1']);
      expect(log.rehydrateSubSession).toEqual([]);
    });

    test('getSession miss with rehydrate hit resolves the same id', async () => {
      const { deps, log } = makeDeps({ rehydrateSubSession: () => ({ id: 'sess-1' }) });
      const target: FindTarget = { kind: 'session', sessionId: 'sess-1' };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'resolved',
        sessionId: 'sess-1',
        created: false,
      });
      expect(log.getSession).toEqual(['sess-1']);
      expect(log.rehydrateSubSession).toEqual(['sess-1']);
    });

    test('both lookups miss returns not_found', async () => {
      const { deps, log } = makeDeps();
      const target: FindTarget = { kind: 'session', sessionId: 'sess-1' };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'unresolved',
        reason: 'not_found',
      });
      expect(log.getSession).toEqual(['sess-1']);
      expect(log.rehydrateSubSession).toEqual(['sess-1']);
    });
  });

  describe('agent kind', () => {
    test('coordinator agentId resolves the space:chat: session id', async () => {
      const spaceId = 'space-1';
      const chatId = coordinatorSessionId(spaceId);
      const { deps, log } = makeDeps({
        getSession: (sessionId) => (sessionId === chatId ? { id: chatId } : null),
      });
      const target: FindTarget = { kind: 'agent', spaceId, agentId: 'coordinator' };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'resolved',
        sessionId: chatId,
        created: false,
      });
      expect(log.getSession).toEqual([chatId]);
    });

    test('plain agentId resolves the space:agent: session id', async () => {
      const spaceId = 'space-1';
      const agentId = 'agent-7';
      const sessionId = longTermAgentSessionId(spaceId, agentId);
      const { deps, log } = makeDeps({
        getSession: (queried) => (queried === sessionId ? { id: sessionId } : null),
      });
      const target: FindTarget = { kind: 'agent', spaceId, agentId };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'resolved',
        sessionId,
        created: false,
      });
      expect(log.getSession).toEqual([sessionId]);
    });

    test('repository-derived coordinator agentId resolves the space:chat: session id', async () => {
      const spaceId = 'space-1';
      const chatId = coordinatorSessionId(spaceId);
      const { deps, log } = makeDeps({
        getCoordinator: () => ({ id: 'coordinator-row-9' }),
        getSession: (queried) => (queried === chatId ? { id: chatId } : null),
      });
      const target: FindTarget = { kind: 'agent', spaceId, agentId: 'coordinator-row-9' };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'resolved',
        sessionId: chatId,
        created: false,
      });
      expect(log.getSession).toEqual([chatId]);
    });

    test('non-coordinator agentId with a coordinator row present resolves the space:agent: id', async () => {
      const spaceId = 'space-1';
      const agentId = 'agent-7';
      const sessionId = longTermAgentSessionId(spaceId, agentId);
      const { deps, log } = makeDeps({
        getCoordinator: () => ({ id: 'coordinator-row-9' }),
        getSession: (queried) => (queried === sessionId ? { id: sessionId } : null),
      });
      const target: FindTarget = { kind: 'agent', spaceId, agentId };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'resolved',
        sessionId,
        created: false,
      });
      expect(log.getSession).toEqual([sessionId]);
    });

    test('missing agent row returns not_found without rehydrating', async () => {
      const { deps, log } = makeDeps();
      const target: FindTarget = { kind: 'agent', spaceId: 'space-1', agentId: 'agent-7' };
      expect(await findSessionForTarget(target, deps)).toEqual({
        kind: 'unresolved',
        reason: 'not_found',
      });
      expect(log.getSession).toEqual([longTermAgentSessionId('space-1', 'agent-7')]);
      expect(log.rehydrateSubSession).toEqual([]);
    });
  });

  describe('never-create law', () => {
    test('no target shape calls ensureLongTermAgent, activateTaskAgent, or spawnPostApprovalWorker', async () => {
      const { deps, log } = makeDeps({
        getSession: () => ({ id: 'row' }),
        rehydrateSubSession: () => ({ id: 'row' }),
      });
      const targets: FindTarget[] = [
        { kind: 'session', sessionId: 'sess-1' },
        { kind: 'agent', spaceId: 'space-1', agentId: 'coordinator' },
        { kind: 'agent', spaceId: 'space-1', agentId: 'agent-7' },
      ];
      for (const target of targets) {
        await findSessionForTarget(target, deps);
      }
      expect(log.ensureLongTermAgent).toEqual([]);
      expect(log.activateTaskAgent).toBe(0);
      expect(log.spawnPostApprovalWorker).toBe(0);
    });
  });
});
