import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, SpaceAgent } from '@hyperneo/shared';
import {
  setupSpaceAgentV2Handlers,
  type SpaceAgentV2Deps,
} from '../../../../src/lib/rpc-handlers/space-agent-v2-handlers';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../../../src/lib/space/agents/worker-long-horizon-mapper';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../../src/storage/schema/m238-space-agent-template-labels';
import { runMigration243 } from '../../../../src/storage/schema/m243-space-agent-template-space-key';
import { runMigration246 } from '../../../../src/storage/schema/m246-template-version-seq-space-key';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((methodName: string, handler: RequestHandler) => {
      handlers.set(methodName, handler);
      return () => handlers.delete(methodName);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function call<T>(handlers: Map<string, RequestHandler>, methodName: string, data: unknown) {
  const handler = handlers.get(methodName);
  if (!handler) throw new Error(`no handler registered for ${methodName}`);
  return handler(data, {}) as Promise<T>;
}

function insertMirror(db: Database, id: string, handle: string, displayName: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, instructions,
       tool_permissions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'space-1',
    handle,
    displayName,
    MIGRATED_WORKER_TEMPLATE_KEY,
    'active',
    '',
    '{}',
    now,
    now
  );
}

const SPACE_ID = 'space-1';

describe('setupSpaceAgentV2Handlers', () => {
  let db: Database;
  let agents: SpaceAgentRepository;
  let legacyAgents: SpaceLongHorizonAgentRepository;
  let removedSubscriptions: Array<{ spaceId: string; agentId: string }>;
  let refreshedSubscriptions: Array<{ spaceId: string; agentId: string }>;
  let clearedProviders: Array<{ spaceId: string; agentId: string }>;
  let seededExtras: Array<{ agentId: string; templateKey: string }>;
  let refreshResult: { success: boolean; error?: string };
  let templates: SpaceAgentTemplateRepository;
  let handlers: Map<string, RequestHandler>;
  let deps: SpaceAgentV2Deps;
  let sessions: Map<string, { type: string; context?: { spaceId?: string | null } | null }>;
  let published: Array<{ topic: string; payload: unknown }>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    runMigration243(db);
    runMigration246(db);
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space One', Date.now(), Date.now());

    agents = new SpaceAgentRepository(db);
    legacyAgents = new SpaceLongHorizonAgentRepository(db);
    removedSubscriptions = [];
    refreshedSubscriptions = [];
    clearedProviders = [];
    seededExtras = [];
    refreshResult = { success: true };
    templates = new SpaceAgentTemplateRepository(db);
    sessions = new Map([
      ['session-1', { type: 'space_chat', context: { spaceId: 'space-1' } }],
      ['session-2', { type: 'space_chat', context: { spaceId: 'space-1' } }],
    ]);
    published = [];
    deps = {
      agents,
      legacyAgents,
      removeAgentSubscriptions: (spaceId, agentId) => {
        removedSubscriptions.push({ spaceId, agentId });
      },
      refreshAgentSubscriptions: (spaceId, agentId) => {
        refreshedSubscriptions.push({ spaceId, agentId });
        return refreshResult;
      },
      clearSessionProvider: async (spaceId, agentId) => {
        clearedProviders.push({ spaceId, agentId });
      },
      seedTemplateExtras: (agent, template) => {
        seededExtras.push({ agentId: agent.id, templateKey: template.key });
      },
      templates,
      reminders: legacyAgents,
      spaceExists: async (id) => id === 'space-1',
      getSession: (id) => sessions.get(id) ?? null,
      internalEventBus: {
        publish: async (topic: string, payload: unknown) => {
          published.push({ topic, payload });
        },
      } as unknown as SpaceAgentV2Deps['internalEventBus'],
    };

    const hubData = createMockMessageHub();
    handlers = hubData.handlers;
    setupSpaceAgentV2Handlers(hubData.hub, deps);
  });

  describe('registration', () => {
    test('registers the six agent methods under spaceAgentV2', () => {
      expect([...handlers.keys()].sort()).toEqual([
        'spaceAgentV2.create',
        'spaceAgentV2.delete',
        'spaceAgentV2.get',
        'spaceAgentV2.list',
        'spaceAgentV2.listReminderCounts',
        'spaceAgentV2.update',
      ]);
    });

    test('does not shadow any spaceAgent method', () => {
      for (const key of handlers.keys()) expect(key.startsWith('spaceAgentV2.')).toBe(true);
    });
  });

  describe('listReminderCounts', () => {
    async function makeAgent(displayName: string): Promise<SpaceAgent> {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName,
      });
      return agent;
    }

    function addReminder(
      agentId: string,
      status: 'active' | 'paused' | 'fired' | 'cancelled'
    ): void {
      legacyAgents.createReminder({
        spaceId: 'space-1',
        agentId,
        title: `reminder ${status}`,
        status,
        triggerType: 'at',
        runAt: Date.now() + 60_000,
      });
    }

    test('counts active reminders per owned agent', async () => {
      const first = await makeAgent('First');
      const second = await makeAgent('Second');
      addReminder(first.id, 'active');
      addReminder(first.id, 'active');
      addReminder(second.id, 'active');

      const { counts } = await call<{ counts: Record<string, number> }>(
        handlers,
        'spaceAgentV2.listReminderCounts',
        { spaceId: 'space-1' }
      );

      expect(counts[first.id]).toBe(2);
      expect(counts[second.id]).toBe(1);
    });

    test('reports zero for an agent with no reminders', async () => {
      const agent = await makeAgent('Quiet');

      const { counts } = await call<{ counts: Record<string, number> }>(
        handlers,
        'spaceAgentV2.listReminderCounts',
        { spaceId: 'space-1' }
      );

      expect(counts[agent.id]).toBe(0);
    });

    test('ignores reminders that are not active', async () => {
      const agent = await makeAgent('Mixed');
      addReminder(agent.id, 'active');
      addReminder(agent.id, 'paused');
      addReminder(agent.id, 'fired');
      addReminder(agent.id, 'cancelled');

      const { counts } = await call<{ counts: Record<string, number> }>(
        handlers,
        'spaceAgentV2.listReminderCounts',
        { spaceId: 'space-1' }
      );

      expect(counts[agent.id]).toBe(1);
    });

    test('keeps the count for an agent whose id is __proto__', async () => {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        id: '__proto__',
        spaceId: 'space-1',
        displayName: 'Proto',
      });
      addReminder(agent.id, 'active');

      const { counts } = await call<{ counts: Record<string, number> }>(
        handlers,
        'spaceAgentV2.listReminderCounts',
        { spaceId: 'space-1' }
      );

      expect(Object.hasOwn(counts, '__proto__')).toBe(true);
      expect(Object.getOwnPropertyDescriptor(counts, '__proto__')?.value).toBe(1);
    });

    test('rejects a request without a spaceId', async () => {
      await expect(call(handlers, 'spaceAgentV2.listReminderCounts', {})).rejects.toThrow(
        'spaceId is required'
      );
    });
  });

  describe('create', () => {
    test('creates an agent from a plain request', async () => {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'My Agent',
      });

      expect(agent.handle).toBe('my-agent');
      expect(agent.displayName).toBe('My Agent');
      expect(agents.getById(agent.id)).not.toBeNull();
    });

    test('copies configuration from a template', async () => {
      templates.createOwned(SPACE_ID, {
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        description: 'Investigates things.',
        instructions: 'Research carefully.',
        suggestedAutonomyLevel: 3,
        tools: ['Read', 'Grep'],
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });

      expect(agent.instructions).toBe('Research carefully.');
      expect(agent.autonomyLevel).toBe(3);
      expect(agent.tools).toEqual(['Read', 'Grep']);
    });

    test('seeds template extras for the created agent', async () => {
      templates.createOwned(SPACE_ID, {
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        instructions: 'Research carefully.',
        suggestedAutonomyLevel: 2,
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });

      expect(seededExtras).toEqual([{ agentId: agent.id, templateKey: 'researcher.v1' }]);
    });

    test('seeds nothing when no template was chosen', async () => {
      await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'Blank',
      });

      expect(seededExtras).toEqual([]);
    });

    test('leaves the created row disconnected from its template', async () => {
      templates.createOwned(SPACE_ID, {
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        instructions: 'Research carefully.',
        suggestedAutonomyLevel: 2,
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });
      const row = db
        .prepare(`SELECT template_key FROM space_long_horizon_agents WHERE id = ?`)
        .get(agent.id) as { template_key: string | null };

      expect(row.template_key).toBeNull();
    });

    test('a later template edit does not touch the created agent', async () => {
      templates.createOwned(SPACE_ID, {
        key: 'researcher.v1',
        handle: 'researcher',
        displayName: 'Researcher',
        instructions: 'Original.',
        suggestedAutonomyLevel: 2,
      });
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });

      templates.casUpdateOwned(SPACE_ID, 'researcher.v1', { instructions: 'Rewritten.' });

      expect(agents.getById(agent.id)?.instructions).toBe('Original.');
    });

    test('surfaces a pipeline rejection as an error', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', templateKey: 'missing.v1' })
      ).rejects.toThrow('Template not found: missing.v1');
    });

    test('rejects an unknown space', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'ghost', displayName: 'X' })
      ).rejects.toThrow('Space not found: ghost');
    });

    test('requires a spaceId', async () => {
      await expect(call(handlers, 'spaceAgentV2.create', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    test('rejects a session already bound to another agent', async () => {
      await call(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'First',
        sessionId: 'session-1',
      });

      await expect(
        call(handlers, 'spaceAgentV2.create', {
          spaceId: 'space-1',
          displayName: 'Second',
          sessionId: 'session-1',
        })
      ).rejects.toThrow('already bound');
    });

    test('rejects a session from another space', async () => {
      sessions.set('foreign', { type: 'space_chat', context: { spaceId: 'space-2' } });

      await expect(
        call(handlers, 'spaceAgentV2.create', {
          spaceId: 'space-1',
          displayName: 'X',
          sessionId: 'foreign',
        })
      ).rejects.toThrow('does not belong to space');
    });

    test('rejects a duplicate display name', async () => {
      await call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', displayName: 'Taken' });

      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', displayName: 'taken' })
      ).rejects.toThrow('is already used');
    });

    test('publishes spaceAgentV2.created carrying the SpaceAgent shape', async () => {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'Publisher',
        tools: ['Read'],
      });

      expect(published.map((event) => event.topic)).toEqual([
        'spaceAgentV2.created',
        'spaceAgent.created',
      ]);
      const payload = published[0].payload as { spaceId: string; agent: SpaceAgent };
      expect(payload.spaceId).toBe('space-1');
      expect(payload.agent.id).toBe(agent.id);
      expect(payload.agent.tools).toEqual(['Read']);
    });

    test('mirrors creation to the legacy event so pre-V2 caches stay current', async () => {
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'Publisher',
        tools: ['Read'],
      });

      const legacy = published.find((event) => event.topic === 'spaceAgent.created');
      const payload = legacy?.payload as { spaceId: string; agent: { id: string } };
      expect(payload.spaceId).toBe('space-1');
      expect(payload.agent).toEqual(legacyAgents.getById(agent.id));
    });

    test('mirrors the stored legacy row, preserving fields the V2 shape cannot express', async () => {
      const existing = legacyAgents.create({
        spaceId: 'space-1',
        handle: 'legacy-made',
        displayName: 'Legacy Made',
        templateKey: 'reviewer.custom',
        toolPermissions: { mode: 'scoped', tools: ['Read'] },
      });
      published = [];

      await call(handlers, 'spaceAgentV2.update', { id: existing.id, displayName: 'Renamed' });

      const legacy = published.find((event) => event.topic === 'spaceAgent.updated');
      const payload = legacy?.payload as {
        agent: { templateKey: string | null; toolPermissions: Record<string, unknown> };
      };
      expect(payload.agent.templateKey).toBe('reviewer.custom');
      expect(payload.agent.toolPermissions).toEqual({ mode: 'scoped', tools: ['Read'] });
    });

    test('does not publish when creation is rejected', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'ghost', displayName: 'X' })
      ).rejects.toThrow();

      expect(published).toHaveLength(0);
    });
  });

  describe('list and get', () => {
    test('list returns agents for the space only', async () => {
      agents.create({ spaceId: 'space-1', handle: 'a' });
      const { agents: listed } = await call<{ agents: SpaceAgent[] }>(
        handlers,
        'spaceAgentV2.list',
        { spaceId: 'space-1' }
      );

      expect(listed.map((a) => a.handle)).toEqual(['a']);
    });

    test('list requires a spaceId', async () => {
      await expect(call(handlers, 'spaceAgentV2.list', {})).rejects.toThrow('spaceId is required');
    });

    test('get returns the agent', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.get', {
        id: created.id,
      });

      expect(agent.id).toBe(created.id);
    });

    test('get throws for an unknown id', async () => {
      await expect(call(handlers, 'spaceAgentV2.get', { id: 'ghost' })).rejects.toThrow(
        'Agent not found: ghost'
      );
    });
  });

  describe('rows sharing handles/names with a pre-existing row', () => {
    test('create still rejects a handle a mirror holds', async () => {
      insertMirror(db, 'mirror-1', 'mirror', 'Legacy Worker');

      await expect(
        call(handlers, 'spaceAgentV2.create', {
          spaceId: 'space-1',
          handle: 'mirror',
          displayName: 'New Agent',
        })
      ).rejects.toThrow('Handle "mirror" is already in use in this space');
    });

    test('create derives a handle around one a mirror holds', async () => {
      insertMirror(db, 'mirror-1', 'mirror-agent', 'Legacy Worker');

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.create', {
        spaceId: 'space-1',
        displayName: 'Mirror Agent',
      });

      expect(agent.handle).toBe('mirror-agent-2');
    });

    test('create still rejects a display name a mirror holds', async () => {
      insertMirror(db, 'mirror-1', 'mirror', 'Legacy Worker');

      await expect(
        call(handlers, 'spaceAgentV2.create', { spaceId: 'space-1', displayName: 'legacy worker' })
      ).rejects.toThrow('is already used by another agent');
    });

    test('update still rejects a display name a mirror holds', async () => {
      insertMirror(db, 'mirror-1', 'mirror', 'Legacy Worker');
      const created = agents.create({ spaceId: 'space-1', handle: 'owned' });

      await expect(
        call(handlers, 'spaceAgentV2.update', { id: created.id, displayName: 'Legacy Worker' })
      ).rejects.toThrow('is already used by another agent');
    });
  });

  describe('update', () => {
    test('refreshes runtime subscriptions after a successful update', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await handlers.get('spaceAgentV2.update')!({ id: created.id, status: 'disabled' });
      expect(refreshedSubscriptions).toEqual([{ spaceId: 'space-1', agentId: created.id }]);
    });

    test('fails the update when the subscription refresh fails', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      refreshResult = { success: false, error: 'trie rebuild failed' };
      await expect(
        handlers.get('spaceAgentV2.update')!({ id: created.id, status: 'disabled' })
      ).rejects.toThrow('trie rebuild failed');
    });

    test('does not publish an updated event when the refresh fails', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      published.length = 0;
      refreshResult = { success: false, error: 'trie rebuild failed' };
      await expect(
        handlers.get('spaceAgentV2.update')!({ id: created.id, status: 'disabled' })
      ).rejects.toThrow();
      expect(published.filter((e) => e.topic === 'spaceAgentV2.updated')).toEqual([]);
    });

    test('clears the provider before the updated event is published', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a', provider: 'anthropic' });
      published.length = 0;
      clearedProviders.length = 0;
      let clearedBeforePublish = false;
      deps.clearSessionProvider = async () => {
        clearedBeforePublish =
          published.filter((e) => e.topic === 'spaceAgentV2.updated').length === 0;
      };
      await handlers.get('spaceAgentV2.update')!({ id: created.id, provider: null });
      expect(clearedBeforePublish).toBe(true);
    });

    test('clears the live session provider when provider is set to null', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a', provider: 'anthropic' });
      await handlers.get('spaceAgentV2.update')!({ id: created.id, provider: null });
      expect(clearedProviders).toEqual([{ spaceId: 'space-1', agentId: created.id }]);
    });

    test('does not clear the provider on unrelated updates', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a', provider: 'anthropic' });
      await handlers.get('spaceAgentV2.update')!({ id: created.id, instructions: 'hi' });
      expect(clearedProviders).toEqual([]);
    });

    test('applies only the supplied fields', async () => {
      const created = agents.create({
        spaceId: 'space-1',
        handle: 'a',
        instructions: 'Keep me.',
      });

      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.update', {
        id: created.id,
        displayName: 'Renamed',
      });

      expect(agent.displayName).toBe('Renamed');
      expect(agent.instructions).toBe('Keep me.');
    });

    test('does not treat id as an updatable field', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      const { agent } = await call<{ agent: SpaceAgent }>(handlers, 'spaceAgentV2.update', {
        id: created.id,
        displayName: 'Renamed',
      });

      expect(agent.id).toBe(created.id);
    });

    test('throws for an unknown id', async () => {
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: 'ghost', displayName: 'X' })
      ).rejects.toThrow('Agent not found: ghost');
    });

    test('publishes spaceAgentV2.updated', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      published = [];

      await call(handlers, 'spaceAgentV2.update', { id: created.id, displayName: 'Renamed' });

      expect(published.map((p) => p.topic)).toEqual(['spaceAgentV2.updated', 'spaceAgent.updated']);
    });

    test('requires an id', async () => {
      await expect(call(handlers, 'spaceAgentV2.update', { displayName: 'X' })).rejects.toThrow(
        'id is required'
      );
    });

    test('rejects an update whose spaceId does not match the agent', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await expect(
        call(handlers, 'spaceAgentV2.update', {
          id: created.id,
          spaceId: 'space-2',
          displayName: 'Renamed',
        })
      ).rejects.toThrow('does not belong to space space-2');
      expect(agents.getById(created.id)?.displayName).toBe('a');
    });

    test('rejects setting status to disabled on a migrated worker mirror', async () => {
      insertMirror(db, 'mirror-1', 'mirror', 'Legacy Worker');
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: 'mirror-1', status: 'disabled' })
      ).rejects.toThrow('cannot be set on a migrated worker agent');
      expect(agents.getById('mirror-1')?.status).toBe('active');
    });
  });

  describe('update validation through the pipeline', () => {
    test('rejects unknown tools', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: created.id, tools: ['NotARealTool'] })
      ).rejects.toThrow('Unknown tool');
    });

    test('rejects a duplicate display name', async () => {
      agents.create({ spaceId: 'space-1', handle: 'a', displayName: 'Taken' });
      const other = agents.create({ spaceId: 'space-1', handle: 'b', displayName: 'Other' });

      await expect(
        call(handlers, 'spaceAgentV2.update', { id: other.id, displayName: 'taken' })
      ).rejects.toThrow('already used');
    });

    test('rejects a reserved handle', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: created.id, handle: 'coordinator' })
      ).rejects.toThrow('is reserved');
    });

    test('rejects a non-string provider from the payload', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: created.id, provider: 42 })
      ).rejects.toThrow('provider must be a string');
    });

    test('rejects an invalid thinkingLevel', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: created.id, thinkingLevel: 'bogus' })
      ).rejects.toThrow('Invalid thinkingLevel');
    });

    test('locks the Space Manager handle', async () => {
      const coordinator = agents.create({ spaceId: 'space-1', handle: 'space-manager' });
      await expect(
        call(handlers, 'spaceAgentV2.update', { id: coordinator.id, handle: 'renamed' })
      ).rejects.toThrow('locked');
    });

    test('rejects a session that belongs to another space', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      sessions.set('foreign', { type: 'space_chat', context: { spaceId: 'space-2' } });

      await expect(
        call(handlers, 'spaceAgentV2.update', { id: created.id, sessionId: 'foreign' })
      ).rejects.toThrow('does not belong to space');
    });

    test('leaves the row untouched when a gate rejects', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a', instructions: 'Keep.' });
      await expect(
        call(handlers, 'spaceAgentV2.update', {
          id: created.id,
          instructions: 'Changed.',
          tools: ['NotARealTool'],
        })
      ).rejects.toThrow();

      expect(agents.getById(created.id)?.instructions).toBe('Keep.');
    });
  });

  describe('delete', () => {
    test('removes the agent', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      const result = await call<{ id: string }>(handlers, 'spaceAgentV2.delete', {
        id: created.id,
      });

      expect(result.id).toBe(created.id);
      expect(agents.getById(created.id)).toBeNull();
    });

    test('throws for an unknown id rather than silently succeeding', async () => {
      await expect(call(handlers, 'spaceAgentV2.delete', { id: 'ghost' })).rejects.toThrow(
        'Agent not found: ghost'
      );
    });

    test('rejects a delete whose spaceId does not match the agent', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      await expect(
        call(handlers, 'spaceAgentV2.delete', { id: created.id, spaceId: 'space-2' })
      ).rejects.toThrow('does not belong to space space-2');
      expect(agents.getById(created.id)).not.toBeNull();
    });

    test('refuses to delete the Space Manager agent', async () => {
      const coordinator = agents.create({ spaceId: 'space-1', handle: 'space-manager' });

      await expect(call(handlers, 'spaceAgentV2.delete', { id: coordinator.id })).rejects.toThrow(
        'Space Manager agent cannot be deleted'
      );
      expect(agents.getById(coordinator.id)).not.toBeNull();
    });

    test('deletes an agent even when a workflow node names it', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'referenced' });
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('wf-1', 'space-1', 'Release Flow', now, now);
      db.prepare(
        `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('node-1', 'wf-1', 'Worker', JSON.stringify({ agentId: created.id }), now, now);

      await call(handlers, 'spaceAgentV2.delete', { id: created.id });

      expect(agents.getById(created.id)).toBeNull();
    });

    test('removes the agent event subscriptions before announcing the delete', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      published = [];

      await call(handlers, 'spaceAgentV2.delete', { id: created.id });

      expect(removedSubscriptions).toEqual([{ spaceId: 'space-1', agentId: created.id }]);
    });

    test('does not remove subscriptions when the delete is refused', async () => {
      const coordinator = agents.create({ spaceId: 'space-1', handle: 'space-manager' });

      await expect(call(handlers, 'spaceAgentV2.delete', { id: coordinator.id })).rejects.toThrow(
        'cannot be deleted'
      );

      expect(removedSubscriptions).toEqual([]);
    });

    test('publishes spaceAgentV2.deleted with the agent space', async () => {
      const created = agents.create({ spaceId: 'space-1', handle: 'a' });
      published = [];

      await call(handlers, 'spaceAgentV2.delete', { id: created.id });

      expect(published.map((event) => event.topic)).toEqual([
        'spaceAgentV2.deleted',
        'spaceAgent.deleted',
      ]);
      for (const event of published) {
        expect(event.payload).toMatchObject({ spaceId: 'space-1', agentId: created.id });
      }
    });
  });
});
