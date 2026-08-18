import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { MessageHub } from '@hyperneo/shared';
import { setupSpaceLongHorizonAgentHandlers } from '../../../../src/lib/rpc-handlers/space-long-horizon-agent-handlers';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockSpaceManager(): SpaceManager {
  type GetSpaceResult = Awaited<ReturnType<SpaceManager['getSpace']>>;
  return {
    getSpace: mock(async (spaceId: string): Promise<GetSpaceResult> => {
      return spaceId === 'space-1' ? ({ id: 'space-1' } as Exclude<GetSpaceResult, null>) : null;
    }),
  } as unknown as SpaceManager;
}

async function call<T>(
  handlers: Map<string, RequestHandler>,
  method: string,
  params: unknown
): Promise<T> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Handler not registered: ${method}`);
  return (await handler(params, {})) as T;
}

describe('Space long-horizon agent handlers', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let repo: SpaceLongHorizonAgentRepository;
  let runtimeService: {
    refreshLongHorizonAgentSubscriptions: ReturnType<typeof mock>;
    refreshLongHorizonSubscription: ReturnType<typeof mock>;
    removeLongHorizonSubscription: ReturnType<typeof mock>;
    removeLongHorizonAgentSubscriptions: ReturnType<typeof mock>;
    clearLongTermAgentSessionProvider: ReturnType<typeof mock>;
  };
  let spaceAgentManager: { listBySpaceId: ReturnType<typeof mock> };
  let internalEventBus: { publish: ReturnType<typeof mock> };

  beforeEach(() => {
    hubData = createMockMessageHub();
    repo = {
      ensureCoordinator: mock(() => {}),
      listBySpaceId: mock(() => []),
      create: mock((params) => ({
        id: params.id ?? 'agent-new',
        ...params,
        spaceId: params.spaceId,
      })),
      getById: mock(() => ({ id: 'agent-1', spaceId: 'space-1' })),
      getByHandle: mock(() => null),
      update: mock((agentId, params) => ({ id: agentId, spaceId: 'space-1', ...params })),
      delete: mock(() => {}),
      listReminders: mock(() => []),
      createReminder: mock(() => ({})),
      deleteReminder: mock(() => {}),
      listSubscriptions: mock(() => []),
      createSubscription: mock((params) => ({
        id: 'sub-1',
        ...params,
        status: params.status ?? 'active',
      })),
      getSubscription: mock(() => ({
        id: 'sub-1',
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/*/*/pull_request/*',
        filter: {},
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })),
      updateSubscription: mock((subscriptionId, params) => ({
        id: subscriptionId,
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: params.source ?? 'github',
        topic: params.topic ?? 'github/*/*/pull_request/*',
        filter: params.filter ?? {},
        status: params.status ?? 'active',
        createdAt: 1,
        updatedAt: 2,
      })),
      deleteSubscription: mock(() => {}),
    } as unknown as SpaceLongHorizonAgentRepository;
    runtimeService = {
      refreshLongHorizonAgentSubscriptions: mock(() => ({ success: true })),
      refreshLongHorizonSubscription: mock(() => ({ success: true })),
      removeLongHorizonSubscription: mock(() => {}),
      removeLongHorizonAgentSubscriptions: mock(() => {}),
      clearLongTermAgentSessionProvider: mock(async () => {}),
    };
    spaceAgentManager = { listBySpaceId: mock(() => []) };
    internalEventBus = { publish: mock(async () => {}) };
    setupSpaceLongHorizonAgentHandlers(
      hubData.hub,
      createMockSpaceManager(),
      repo,
      spaceAgentManager as never,
      runtimeService,
      internalEventBus as never
    );
  });

  describe('spaceLongHorizonAgent.create', () => {
    it('uses a non-conflicting mirror handle when requested handle belongs to another row', async () => {
      repo.getByHandle = mock(() => ({
        id: 'standalone-agent',
        spaceId: 'space-1',
        handle: 'researcher',
      })) as SpaceLongHorizonAgentRepository['getByHandle'];
      repo.listBySpaceId = mock(() => [
        { id: 'standalone-agent', spaceId: 'space-1', handle: 'researcher' },
        { id: 'existing-events-agent', spaceId: 'space-1', handle: 'researcher-events' },
      ]) as SpaceLongHorizonAgentRepository['listBySpaceId'];

      const result = await call<{ agent: { id: string; handle: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.create',
        {
          id: 'visible-agent',
          spaceId: 'space-1',
          handle: 'researcher',
          displayName: 'Researcher',
        }
      );

      expect(result.agent).toEqual(
        expect.objectContaining({ id: 'visible-agent', handle: 'researcher-2' })
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'visible-agent', handle: 'researcher-2' })
      );
    });

    it('slugifies raw RPC handles before exposing actor handles', async () => {
      const result = await call<{ agent: { id: string; handle: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.create',
        {
          id: 'visible-agent',
          spaceId: 'space-1',
          handle: 'QA/Review',
          displayName: 'QA Review',
        }
      );

      expect(result.agent.handle).toBe('qa-review');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ handle: 'qa-review' }));
    });

    it('reserves worker handles for RPC-created long-horizon agents', async () => {
      spaceAgentManager.listBySpaceId = mock(() => [
        { id: 'worker-agent', spaceId: 'space-1', handle: 'coder' },
      ]);

      const result = await call<{ agent: { id: string; handle: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.create',
        {
          id: 'visible-agent',
          spaceId: 'space-1',
          handle: 'coder',
          displayName: 'Coder',
        }
      );

      expect(result.agent.handle).toBe('coder-2');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ handle: 'coder-2' }));
    });

    it('publishes created events after successful RPC creates', async () => {
      const result = await call<{ agent: { id: string; spaceId: string; handle: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.create',
        {
          id: 'visible-agent',
          spaceId: 'space-1',
          handle: 'observer',
          displayName: 'Observer',
        }
      );

      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceLongHorizonAgent.created', {
        sessionId: 'space:space-1',
        spaceId: 'space-1',
        agent: result.agent,
      });
    });
  });

  describe('spaceLongHorizonAgent.update', () => {
    it('rejects invalid raw handle updates', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.update', {
          agentId: 'agent-1',
          spaceId: 'space-1',
          handle: 'ops:bot',
        })
      ).rejects.toThrow('Invalid agent handle');

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('rejects handle updates that collide with worker agents', async () => {
      spaceAgentManager.listBySpaceId = mock(() => [
        { id: 'worker-agent', spaceId: 'space-1', handle: 'coder' },
      ]);

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.update', {
          agentId: 'agent-1',
          spaceId: 'space-1',
          handle: 'coder',
        })
      ).rejects.toThrow('An agent with handle "coder" already exists in this Space');

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows shared-ID long-horizon agents to keep their worker handle', async () => {
      spaceAgentManager.listBySpaceId = mock(() => [
        { id: 'agent-1', spaceId: 'space-1', handle: 'coder' },
      ]);

      const result = await call<{ agent: { id: string; handle: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.update',
        {
          agentId: 'agent-1',
          spaceId: 'space-1',
          handle: 'coder',
        }
      );

      expect(result.agent.handle).toBe('coder');
      expect(repo.update).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ handle: 'coder' })
      );
    });

    it('clears the session provider when the override is explicitly cleared (P2)', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.update', {
        agentId: 'agent-1',
        spaceId: 'space-1',
        provider: null,
      });

      expect(runtimeService.clearLongTermAgentSessionProvider).toHaveBeenCalledWith(
        'space-1',
        'agent-1'
      );
    });

    it('does not clear the session provider when the override is set or untouched', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.update', {
        agentId: 'agent-1',
        spaceId: 'space-1',
        provider: 'kimi',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.update', {
        agentId: 'agent-1',
        spaceId: 'space-1',
        displayName: 'Renamed',
      });

      expect(runtimeService.clearLongTermAgentSessionProvider).not.toHaveBeenCalled();
    });

    it('refreshes durable subscriptions and publishes updated events after policy updates', async () => {
      const result = await call<{ agent: { id: string; status: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.update',
        {
          agentId: 'agent-1',
          spaceId: 'space-1',
          status: 'paused',
          handle: 'coder',
          provider: 'openrouter',
          settingSources: ['project'],
          toolPermissions: { tools: ['Read'] },
        }
      );

      expect(result.agent).toEqual(expect.objectContaining({ id: 'agent-1', status: 'paused' }));
      expect(repo.update).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          status: 'paused',
          handle: 'coder',
          provider: 'openrouter',
          settingSources: ['project'],
          toolPermissions: { tools: ['Read'] },
        })
      );
      expect(runtimeService.refreshLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        'agent-1'
      );
      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceLongHorizonAgent.updated', {
        sessionId: 'space:space-1',
        spaceId: 'space-1',
        agent: result.agent,
      });
    });
  });

  describe('spaceLongHorizonAgent.delete', () => {
    it('removes runtime subscriptions before deleting the agent row', async () => {
      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceLongHorizonAgent.delete',
        {
          agentId: 'agent-1',
          spaceId: 'space-1',
        }
      );

      expect(result).toEqual({ success: true });
      expect(runtimeService.removeLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        'agent-1'
      );
      expect(repo.delete).toHaveBeenCalledWith('agent-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('spaceLongHorizonAgent.deleted', {
        sessionId: 'space:space-1',
        spaceId: 'space-1',
        agentId: 'agent-1',
      });
    });
  });

  describe('spaceLongHorizonAgent.subscriptions', () => {
    it('lists subscriptions for an agent', async () => {
      const result = await call<{ subscriptions: unknown[] }>(
        hubData.handlers,
        'spaceLongHorizonAgent.listSubscriptions',
        { agentId: 'agent-1', spaceId: 'space-1' }
      );

      expect(result.subscriptions).toEqual([]);
      expect(repo.listSubscriptions).toHaveBeenCalledWith('agent-1');
    });

    it('creates subscriptions and refreshes runtime target', async () => {
      const result = await call<{ subscription: { id: string; topic: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.createSubscription',
        {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
          filter: { label: 'PRs' },
        }
      );

      expect(result.subscription.id).toBe('sub-1');
      expect(repo.createSubscription).toHaveBeenCalledWith({
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/*/*/pull_request/*',
        filter: { label: 'PRs' },
        status: undefined,
      });
      expect(runtimeService.refreshLongHorizonSubscription).toHaveBeenCalledWith(
        'space-1',
        'sub-1'
      );
    });

    it('rejects unregistered subscription sources', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'gihub',
          topic: 'lsm/neokai/pull_request/*',
        })
      ).rejects.toThrow('Source "gihub" is not registered');
    });

    it('rejects full topics whose source differs from the source field', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'space/task.done',
        })
      ).rejects.toThrow('Topic source "space" does not match source "github"');
    });

    it('rejects full topics whose source casing differs from the source field', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'GitHub/lsm/neokai/pull_request/*',
        })
      ).rejects.toThrow('Topic source "GitHub" does not match source "github"');
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'Space/task.done',
        })
      ).rejects.toThrow('Topic source "Space" does not match source "github"');
    });

    it('accepts GitHub owner/repo topic shorthands before known-source prefix checks', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'space/neokai/pull_request/*',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/neokai/pull_request/*',
      });

      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'space/neokai/pull_request/*' })
      );
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'github/neokai/pull_request/*' })
      );
    });

    it('rejects slash-separated GitHub entity actions', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42/closed',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42/closed" must use dotted entity actions like "pull_request/42.closed"'
      );
    });

    it('rejects GitHub entity patterns without dotted actions', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/42',
        })
      ).rejects.toThrow(
        'GitHub topic "github/owner/repo/pull_request/42" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request/42',
        })
      ).rejects.toThrow(
        'GitHub topic "pull_request/42" must use dotted entity actions like "pull_request/42.opened"'
      );
    });

    it('rejects unsupported GitHub resources in exact and bare patterns', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/issue/42.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/issue/42.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/issue/42.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "github/owner/repo/issue/42.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'issue',
        })
      ).rejects.toThrow(
        'GitHub topic "issue" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'issue.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "issue.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/issue.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/issue.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
    });

    it('rejects malformed GitHub entity actions and overlong shapes', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/.opened" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42.',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42." must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42.opened.extra',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42.opened.extra" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42.opened/extra/x',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42.opened/extra/x" must match supported shape "owner/repo/pull_request/<id>.<action>"'
      );
    });

    it('expands GitHub resource shorthands with entity wildcards', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'pull_request.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'owner/repo/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/owner/repo/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'owner/repo/pull_request.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request/*.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request/42.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/neokai/pull_request/*',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'space/neokai/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/neokai/pull_request.closed',
      });

      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'github/neokai/pull_request/*' })
      );
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'space/neokai/pull_request' })
      );
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'github/neokai/pull_request.closed' })
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request.closed',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*.closed',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*.closed'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/pull_request.closed',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*.closed',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*.closed'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/owner/repo/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/owner/repo/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request.closed',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/*.closed',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/owner/repo/pull_request/*.closed'
      );
    });

    it('rejects duplicate canonical subscription patterns', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: '*/*/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
          filter: { label: 'Duplicate label' },
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );
    });

    it('rejects case-only duplicate event patterns', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/*',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'Owner/Repo/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/Owner/Repo/pull_request/*'
      );
    });

    it('allows non-duplicate subscription patterns for the same agent', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/*',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'owner/repo/pull_request/*.closed',
      });

      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'owner/repo/pull_request/*.closed' })
      );
    });

    it('skips invalid existing subscriptions during duplicate checks', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-invalid',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'space/task.done',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      const result = await call<{ subscription: { id: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.createSubscription',
        {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request',
        }
      );

      expect(result.subscription.id).toBe('sub-1');
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'pull_request' })
      );
    });

    it('updates subscriptions and refreshes runtime target', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.updateSubscription', {
        subscriptionId: 'sub-1',
        spaceId: 'space-1',
        status: 'paused',
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-1', { status: 'paused' });
      expect(runtimeService.refreshLongHorizonSubscription).toHaveBeenCalledWith(
        'space-1',
        'sub-1'
      );
    });

    it('allows status-only updates for wildcard-source subscriptions', async () => {
      repo.getSubscription = mock(() => ({
        id: 'sub-wildcard',
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: '*',
        topic: '*/space/task.updated',
        filter: {},
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })) as unknown as SpaceLongHorizonAgentRepository['getSubscription'];
      repo.updateSubscription = mock((subscriptionId, params) => ({
        id: subscriptionId,
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: '*',
        topic: '*/space/task.updated',
        filter: {},
        status: params.status ?? 'active',
        createdAt: 1,
        updatedAt: 2,
      })) as unknown as SpaceLongHorizonAgentRepository['updateSubscription'];

      await call(hubData.handlers, 'spaceLongHorizonAgent.updateSubscription', {
        subscriptionId: 'sub-wildcard',
        spaceId: 'space-1',
        status: 'paused',
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-wildcard', { status: 'paused' });
    });

    it('rejects topic edits for wildcard-source subscriptions', async () => {
      repo.getSubscription = mock(() => ({
        id: 'sub-wildcard',
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: '*',
        topic: '*/space/task.updated',
        filter: {},
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })) as unknown as SpaceLongHorizonAgentRepository['getSubscription'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.updateSubscription', {
          subscriptionId: 'sub-wildcard',
          spaceId: 'space-1',
          topic: '*/space/task.done',
        })
      ).rejects.toThrow('Source "*" must be lowercase');
    });

    it('deletes subscriptions and removes runtime target before deleting row', async () => {
      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceLongHorizonAgent.deleteSubscription',
        { subscriptionId: 'sub-1', spaceId: 'space-1' }
      );

      expect(result).toEqual({ success: true });
      expect(runtimeService.removeLongHorizonSubscription).toHaveBeenCalledWith('space-1', 'sub-1');
      expect(repo.deleteSubscription).toHaveBeenCalledWith('sub-1');
    });
  });

  describe('spaceLongHorizonAgent.listReminderCounts', () => {
    it('returns active-reminder counts for each requested agent in one call', async () => {
      repo.listReminders = mock((agentId: string) => {
        if (agentId === 'agent-1') {
          return [
            { id: 'r1', status: 'active' },
            { id: 'r2', status: 'active' },
            { id: 'r3', status: 'paused' },
          ];
        }
        if (agentId === 'agent-2') {
          return [{ id: 'r4', status: 'fired' }];
        }
        return [];
      }) as SpaceLongHorizonAgentRepository['listReminders'];

      const result = await call<{ counts: Record<string, number> }>(
        hubData.handlers,
        'spaceLongHorizonAgent.listReminderCounts',
        { agentIds: ['agent-1', 'agent-2', 'agent-3'] }
      );

      expect(result.counts).toEqual({ 'agent-1': 2, 'agent-2': 0, 'agent-3': 0 });
      expect(repo.listReminders).toHaveBeenCalledWith('agent-1');
      expect(repo.listReminders).toHaveBeenCalledWith('agent-2');
      expect(repo.listReminders).toHaveBeenCalledWith('agent-3');
    });

    it('rejects when agentIds is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.listReminderCounts', {})
      ).rejects.toThrow('agentIds is required');
    });
  });

  describe('spaceLongHorizonAgent.listBuiltInTemplates', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceLongHorizonAgent.listBuiltInTemplates')).toBe(true);
    });

    it('returns built-in long-horizon agent templates', async () => {
      const result = await call<{
        templates: Array<{
          key: string;
          suggestedEventSubscriptions: unknown[];
          reminderDefaults: unknown[];
          ownershipPatterns: unknown[];
        }>;
      }>(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {
        spaceId: 'space-1',
      });

      expect(result.templates).toHaveLength(8);
      expect(result.templates.map((template) => template.key)).toContain('coordinator.default');
      for (const template of result.templates) {
        expect(template.suggestedEventSubscriptions.length).toBeGreaterThan(0);
        expect(template.reminderDefaults.length).toBeGreaterThan(0);
        expect(template.ownershipPatterns.length).toBeGreaterThan(0);
      }
    });

    it('throws when spaceId is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {})
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {
          spaceId: 'missing-space',
        })
      ).rejects.toThrow('Space not found: missing-space');
    });
  });
});

describe('spaceLongHorizonAgent.createReminder — nextRunAt seeding', () => {
  let db: Database;
  let repo: SpaceLongHorizonAgentRepository;
  let handlers: Map<string, RequestHandler>;
  let agentId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.prepare(
      `INSERT INTO spaces (
				id, slug, workspace_path, name, description, background_context, instructions,
				allowed_models, session_ids, status, paused, stopped, autonomy_level,
				max_concurrent_tasks, created_at, updated_at
			) VALUES (?, ?, ?, '', '', '', '', '[]', '[]', 'active', 0, 0, 1, 1, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 1, 1);
    repo = new SpaceLongHorizonAgentRepository(db);
    const agent = repo.create({ spaceId: 'space-1', handle: 'steward', displayName: 'Steward' });
    agentId = agent.id;

    const hubData = createMockMessageHub();
    handlers = hubData.handlers;
    setupSpaceLongHorizonAgentHandlers(hubData.hub, createMockSpaceManager(), repo);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds nextRunAt for a cron reminder so the scanner selects it when due', async () => {
    const result = await call<{ reminder: { id: string; nextRunAt: number | null } }>(
      handlers,
      'spaceLongHorizonAgent.createReminder',
      {
        spaceId: 'space-1',
        agentId,
        title: 'Weekly review',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1',
      }
    );
    expect(result.reminder.nextRunAt).not.toBeNull();
    const nextRunAt = result.reminder.nextRunAt as number;
    expect(repo.listDueReminders(Date.now()).map((r) => r.id)).toEqual([]);
    expect(repo.listDueReminders(nextRunAt + 1000).map((r) => r.id)).toEqual([result.reminder.id]);
  });

  it('seeds nextRunAt = runAt for a one-shot "at" reminder and is immediately due', async () => {
    const runAt = Date.now() - 1000;
    const result = await call<{ reminder: { id: string; nextRunAt: number | null } }>(
      handlers,
      'spaceLongHorizonAgent.createReminder',
      {
        spaceId: 'space-1',
        agentId,
        title: 'Once',
        triggerType: 'at',
        runAt,
      }
    );
    expect(result.reminder.nextRunAt).toBe(runAt);
    expect(repo.listDueReminders(Date.now()).map((r) => r.id)).toEqual([result.reminder.id]);
  });

  it('requires runAt for triggerType "at"', async () => {
    await expect(
      call(handlers, 'spaceLongHorizonAgent.createReminder', {
        spaceId: 'space-1',
        agentId,
        title: 'no-runat',
        triggerType: 'at',
      })
    ).rejects.toThrow('runAt is required for triggerType "at"');
  });

  it('rejects an invalid cron expression', async () => {
    await expect(
      call(handlers, 'spaceLongHorizonAgent.createReminder', {
        spaceId: 'space-1',
        agentId,
        title: 'bad-cron',
        triggerType: 'cron',
        cronExpression: 'not a cron',
      })
    ).rejects.toThrow('Invalid cron expression');
  });
});
