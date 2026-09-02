import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
  insertWorkflowNode,
} from '../../helpers/space-agent-schema';

describe('SpaceAgentRepository', () => {
  let db: Database;
  let repo: SpaceAgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    repo = new SpaceAgentRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('creates an agent with required fields', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });

      expect(agent.id).toBeDefined();
      expect(agent.spaceId).toBe('space-1');
      expect(agent.name).toBe('Coder');
      expect(agent.handle).toBe('coder');
      expect(agent.description).toBeUndefined();
      expect(agent.customPrompt).toBeNull();
      expect(agent.model).toBeUndefined();
      expect(agent.provider).toBeUndefined();
      expect(agent.createdAt).toBeGreaterThan(0);
      expect(agent.updatedAt).toBeGreaterThan(0);
    });

    it('creates an agent with all optional fields', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Planner',
        description: 'Plans tasks',
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        customPrompt: 'You are a planner\n\nFollow these steps...',
      });

      expect(agent.name).toBe('Planner');
      expect(agent.description).toBe('Plans tasks');
      expect(agent.model).toBe('claude-opus-4-6');
      expect(agent.provider).toBe('anthropic');
      expect(agent.customPrompt).toBe('You are a planner\n\nFollow these steps...');
    });

    it('stores tools as JSON array', () => {
      repo.create({
        spaceId: 'space-1',
        name: 'Agent',
        tools: ['Bash', 'Read'],
      });
      const raw = db.prepare(`SELECT tools FROM space_agents WHERE name = 'Agent'`).get() as {
        tools: string;
      };
      expect(JSON.parse(raw.tools)).toEqual(['Bash', 'Read']);
    });

    it('uses explicit handles and auto-suffixes generated collisions', () => {
      const first = repo.create({ spaceId: 'space-1', name: 'QA Agent', handle: 'qa' });
      const second = repo.create({ spaceId: 'space-1', name: 'QA Agent' });

      expect(first.handle).toBe('qa');
      expect(second.handle).toBe('qa-agent');
    });

    it('avoids reserved system handles when auto-generating handles', () => {
      const coordinator = repo.create({ spaceId: 'space-1', name: 'Coordinator' });
      const systemRuntime = repo.create({ spaceId: 'space-1', name: 'System Runtime' });

      expect(coordinator.handle).toBe('coordinator-2');
      expect(systemRuntime.handle).toBe('system-runtime-2');
    });
  });

  describe('getById', () => {
    it('returns agent by id', () => {
      const created = repo.create({ spaceId: 'space-1', name: 'Agent' });
      const found = repo.getById(created.id);
      expect(found?.id).toBe(created.id);
    });

    it('returns null for unknown id', () => {
      expect(repo.getById('nonexistent')).toBeNull();
    });

    it('normalizes a legacy empty-string tools column to an inherit-all profile', () => {
      const created = repo.create({ spaceId: 'space-1', name: 'Legacy' });
      db.prepare(`UPDATE space_agents SET tools = '' WHERE id = ?`).run(created.id);

      const agent = repo.getById(created.id);
      expect(agent?.tools).toEqual([]);
    });
  });

  describe('getBySpaceId', () => {
    it('returns all agents for a space in creation order', () => {
      repo.create({ spaceId: 'space-1', name: 'A' });
      repo.create({ spaceId: 'space-1', name: 'B' });
      const agents = repo.getBySpaceId('space-1');
      expect(agents).toHaveLength(2);
      expect(agents[0].name).toBe('A');
      expect(agents[1].name).toBe('B');
    });

    it('returns empty array for space with no agents', () => {
      insertSpace(db, 'space-2');
      expect(repo.getBySpaceId('space-2')).toEqual([]);
    });
  });

  describe('isNameTaken', () => {
    it('returns false when no agent with that name exists', () => {
      expect(repo.isNameTaken('space-1', 'Coder')).toBe(false);
    });

    it('returns true when an agent with that name exists', () => {
      repo.create({ spaceId: 'space-1', name: 'Coder' });
      expect(repo.isNameTaken('space-1', 'Coder')).toBe(true);
    });

    it('is case-insensitive', () => {
      repo.create({ spaceId: 'space-1', name: 'Coder' });
      expect(repo.isNameTaken('space-1', 'CODER')).toBe(true);
      expect(repo.isNameTaken('space-1', 'coder')).toBe(true);
    });

    it('excludes the specified agent id (update scenario)', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });
      expect(repo.isNameTaken('space-1', 'Coder', agent.id)).toBe(false);
    });

    it('is scoped to the space', () => {
      insertSpace(db, 'space-2');
      repo.create({ spaceId: 'space-1', name: 'Coder' });
      expect(repo.isNameTaken('space-2', 'Coder')).toBe(false);
    });
  });

  describe('getAgentsByIds', () => {
    it('returns only the requested agents', () => {
      const a = repo.create({ spaceId: 'space-1', name: 'A' });
      const b = repo.create({ spaceId: 'space-1', name: 'B' });
      repo.create({ spaceId: 'space-1', name: 'C' });

      const result = repo.getAgentsByIds([a.id, b.id]);
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['A', 'B']);
    });

    it('returns empty array for empty ids', () => {
      expect(repo.getAgentsByIds([])).toEqual([]);
    });

    it('skips unknown ids without error', () => {
      const a = repo.create({ spaceId: 'space-1', name: 'A' });
      const result = repo.getAgentsByIds([a.id, 'nonexistent']);
      expect(result).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('updates individual fields', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Original' });

      const updated = repo.update(agent.id, {
        name: 'Renamed',
        customPrompt: 'Updated prompt',
      });

      expect(updated?.name).toBe('Renamed');
      expect(updated?.customPrompt).toBe('Updated prompt');
    });

    it('sets model and provider to null', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'opus',
        provider: 'anthropic',
      });

      const updated = repo.update(agent.id, { model: null, provider: null });
      expect(updated?.model).toBeUndefined();
      expect(updated?.provider).toBeUndefined();
    });

    it('clears description to undefined via null', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Agent',
        description: 'Some description',
        customPrompt: 'Some prompt',
      });
      expect(agent.description).toBe('Some description');
      expect(agent.customPrompt).toBe('Some prompt');

      const updated = repo.update(agent.id, { description: null, customPrompt: null });
      expect(updated?.description).toBeUndefined();
      expect(updated?.customPrompt).toBeNull();
    });

    it('sets and clears customPrompt', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Agent',
        customPrompt: 'Do step 1, then step 2.',
      });
      expect(agent.customPrompt).toBe('Do step 1, then step 2.');

      const updated = repo.update(agent.id, { customPrompt: null });
      expect(updated?.customPrompt).toBeNull();
    });

    it('returns null for unknown id', () => {
      expect(repo.update('nonexistent', { name: 'X' })).toBeNull();
    });

    it('no-op update returns unchanged agent', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      const updated = repo.update(agent.id, {});
      expect(updated?.name).toBe('Agent');
    });
  });

  describe('delete', () => {
    it('removes the agent', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      repo.delete(agent.id);
      expect(repo.getById(agent.id)).toBeNull();
    });

    it('is idempotent for unknown ids', () => {
      expect(() => repo.delete('nonexistent')).not.toThrow();
    });

    function createInboxTable(): void {
      db.exec(`
        CREATE TABLE space_agent_inbox_messages (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          source_actor_id TEXT NOT NULL,
          message TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    }

    function seedInboxRow(id: string, spaceId: string, targetAgentId: string): void {
      db.prepare(
        `INSERT INTO space_agent_inbox_messages
         (id, space_id, target_agent_id, source_actor_id, message, expires_at, created_at)
         VALUES (?, ?, ?, 'src', 'hello', 9999, 1)`
      ).run(id, spaceId, targetAgentId);
    }

    function inboxRowsFor(agentId: string): number {
      return (
        db
          .prepare(`SELECT COUNT(*) AS n FROM space_agent_inbox_messages WHERE target_agent_id = ?`)
          .get(agentId) as { n: number }
      ).n;
    }

    it('purges sibling inbox rows when no long-horizon row shares the id', () => {
      createInboxTable();
      const a = repo.create({ spaceId: 'space-1', name: 'A' });
      const b = repo.create({ spaceId: 'space-1', name: 'B' });
      seedInboxRow('in-a', 'space-1', a.id);
      seedInboxRow('in-b', 'space-1', b.id);

      repo.delete(a.id);

      expect(inboxRowsFor(a.id)).toBe(0);
      expect(inboxRowsFor(b.id)).toBe(1);
    });

    it('keeps inbox rows when a long-horizon row shares the id in the same space', () => {
      createInboxTable();
      const worker = repo.create({ spaceId: 'space-1', name: 'Shared' });
      db.prepare(
        `UPDATE space_long_horizon_agents SET template_key = 'coordinator.default' WHERE id = ?`
      ).run(worker.id);
      seedInboxRow('in-shared', 'space-1', worker.id);

      repo.delete(worker.id);

      expect(repo.getById(worker.id)).toBeNull();
      expect(inboxRowsFor(worker.id)).toBe(1);
    });

    it('purges inbox rows when the same-id long-horizon row lives in another space', () => {
      createInboxTable();
      insertSpace(db, 'space-2');
      const worker = repo.create({ spaceId: 'space-1', name: 'Shared' });
      db.prepare(`DELETE FROM space_long_horizon_agents WHERE id = ?`).run(worker.id);
      db.prepare(
        `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, created_at, updated_at)
       VALUES (?, 'space-2', 'shared', 'Shared', 1, 1)`
      ).run(worker.id);
      seedInboxRow('in-shared', 'space-1', worker.id);

      repo.delete(worker.id);

      expect(inboxRowsFor(worker.id)).toBe(0);
    });
  });

  describe('isAgentReferenced', () => {
    it('returns not-referenced when no nodes reference the agent', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      const result = repo.isAgentReferenced(agent.id);
      expect(result.referenced).toBe(false);
      expect(result.workflowNames).toEqual([]);
    });

    it('returns referenced with workflow names when nodes use the agent', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      insertWorkflow(db, 'wf-1', 'space-1', 'Deploy Workflow');
      insertWorkflowNode(db, 'node-1', 'wf-1', agent.id);

      const result = repo.isAgentReferenced(agent.id);
      expect(result.referenced).toBe(true);
      expect(result.workflowNames).toContain('Deploy Workflow');
    });

    it('returns unique workflow names even with multiple nodes from same workflow', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      insertWorkflow(db, 'wf-2', 'space-1', 'CI Workflow');
      insertWorkflowNode(db, 'node-a', 'wf-2', agent.id);
      insertWorkflowNode(db, 'node-b', 'wf-2', agent.id);

      const result = repo.isAgentReferenced(agent.id);
      expect(result.workflowNames).toHaveLength(1);
      expect(result.workflowNames[0]).toBe('CI Workflow');
    });
  });

  describe('unified-table mirror (U3a write sync)', () => {
    function unifiedRow(agentId: string): Record<string, unknown> | undefined {
      return db.prepare(`SELECT * FROM space_long_horizon_agents WHERE id = ?`).get(agentId) as
        | Record<string, unknown>
        | undefined;
    }

    function insertLongHorizonAgent(id: string, handle: string, templateKey: string | null): void {
      db.prepare(
        `INSERT INTO space_long_horizon_agents
           (id, space_id, handle, display_name, template_key, status, instructions,
            tool_permissions_json, created_at, updated_at)
         VALUES (?, 'space-1', ?, 'Other', ?, 'active', '', '{}', 1, 1)`
      ).run(id, handle, templateKey);
    }

    it('create mirrors the worker row into the unified table with the same id', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'Writes code',
        model: 'kimi-for-coding',
        provider: 'kimi',
        customPrompt: 'Do the work',
        tools: ['Bash', 'Read'],
        modelPool: [{ model: 'kimi-for-coding', maxConcurrent: 1, weight: 1 }],
      });

      const row = unifiedRow(agent.id);
      expect(row).toBeDefined();
      expect(row?.space_id).toBe('space-1');
      expect(row?.handle).toBe('coder');
      expect(row?.display_name).toBe('Coder');
      expect(row?.template_key).toBe('migration.legacy_space_agent');
      expect(row?.status).toBe('active');
      expect(row?.instructions).toBe('Do the work');
      expect(JSON.parse(row?.tool_permissions_json as string)).toEqual({ tools: ['Bash', 'Read'] });
      expect(row?.model).toBe('kimi-for-coding');
      expect(row?.provider).toBe('kimi');
      expect(row?.description).toBe('Writes code');
      expect(JSON.parse(row?.model_pool as string)).toEqual([
        { model: 'kimi-for-coding', maxConcurrent: 1, weight: 1 },
      ]);
    });

    it('create maps an empty tool list to the inherit-all permission object', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Plain' });
      const row = unifiedRow(agent.id);
      expect(row?.tool_permissions_json).toBe('{}');
      expect(row?.model_pool).toBeNull();
    });

    it('update mirrors field edits into the unified row', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Original',
        customPrompt: 'Old prompt',
        tools: ['Bash'],
      });

      repo.update(agent.id, {
        name: 'Renamed',
        customPrompt: 'New prompt',
        tools: ['Read'],
        model: 'claude-sonnet-4-6',
        status: 'paused',
      });

      const row = unifiedRow(agent.id);
      expect(row?.display_name).toBe('Renamed');
      expect(row?.instructions).toBe('New prompt');
      expect(JSON.parse(row?.tool_permissions_json as string)).toEqual({ tools: ['Read'] });
      expect(row?.model).toBe('claude-sonnet-4-6');
      expect(row?.status).toBe('paused');
    });

    it('update keeps the worker and mirror handles in sync when the handle is renamed', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });
      expect(unifiedRow(agent.id)?.handle).toBe('coder');

      repo.update(agent.id, { handle: 'renamed' });

      expect(repo.getById(agent.id)?.handle).toBe('renamed');
      expect(unifiedRow(agent.id)?.handle).toBe('renamed');
    });

    it('update aligns a colliding rename onto the same suffixed handle in both rows', () => {
      insertLongHorizonAgent('lh-1', 'renamed', 'coordinator.default');
      const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });

      repo.update(agent.id, { handle: 'renamed' });

      const aligned = `renamed-${agent.id}`;
      expect(repo.getById(agent.id)?.handle).toBe(aligned);
      expect(unifiedRow(agent.id)?.handle).toBe(aligned);
    });

    it('worker edits leave a genuine same-id overlay untouched', () => {
      const agent = repo.create({
        spaceId: 'space-1',
        name: 'Original',
        handle: 'original',
        customPrompt: 'Old prompt',
        tools: ['Bash'],
        model: 'm1',
        provider: 'p1',
        modelPool: [{ model: 'm1', maxConcurrent: 1, weight: 1 }],
      });
      db.prepare(
        `UPDATE space_long_horizon_agents SET template_key = 'coordinator.default' WHERE id = ?`
      ).run(agent.id);
      const overlayBefore = { ...unifiedRow(agent.id) };

      repo.update(agent.id, {
        name: 'Renamed',
        handle: 'renamed',
        status: 'paused',
        description: 'New description',
        model: 'm2',
        provider: 'p2',
        customPrompt: 'New prompt',
        tools: ['Read'],
        settingSources: ['project'],
        modelPool: [{ model: 'm2', maxConcurrent: 2, weight: 1 }],
      });

      expect(repo.getById(agent.id)).toEqual(
        expect.objectContaining({
          name: 'Renamed',
          handle: 'renamed',
          status: 'paused',
          description: 'New description',
          model: 'm2',
          provider: 'p2',
          customPrompt: 'New prompt',
        })
      );
      expect(unifiedRow(agent.id)).toEqual(overlayBefore);
    });

    it('create aligns the worker handle with the mirror when a genuine agent holds it', () => {
      insertLongHorizonAgent('lh-1', 'coder', 'coordinator.default');

      const agent = repo.create({ spaceId: 'space-1', name: 'Coder', handle: 'coder' });

      expect(agent.handle).toBe(`coder-${agent.id}`);
      expect(repo.getById(agent.id)?.handle).toBe(`coder-${agent.id}`);
      expect(unifiedRow(agent.id)?.handle).toBe(`coder-${agent.id}`);
    });

    it('generated handles avoid unified-table handles alongside worker handles', () => {
      insertLongHorizonAgent('lh-1', 'coder', 'coordinator.default');

      const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });

      expect(agent.handle).toBe('coder-2');
      expect(unifiedRow(agent.id)?.handle).toBe('coder-2');
    });

    it('delete removes the unified mirror and purges inbox rows with it', () => {
      db.exec(`
        CREATE TABLE space_agent_inbox_messages (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          source_actor_id TEXT NOT NULL,
          message TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });
      db.prepare(
        `INSERT INTO space_agent_inbox_messages
         (id, space_id, target_agent_id, source_actor_id, message, expires_at, created_at)
         VALUES ('in-1', 'space-1', ?, 'src', 'hello', 9999, 1)`
      ).run(agent.id);

      repo.delete(agent.id);

      expect(repo.getById(agent.id)).toBeNull();
      expect(unifiedRow(agent.id)).toBeNull();
      const inbox = db
        .prepare(`SELECT COUNT(*) AS n FROM space_agent_inbox_messages WHERE target_agent_id = ?`)
        .get(agent.id) as { n: number };
      expect(inbox.n).toBe(0);
    });

    it('delete keeps a same-id long-horizon overlay row and its inbox rows', () => {
      db.exec(`
        CREATE TABLE space_agent_inbox_messages (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          source_actor_id TEXT NOT NULL,
          message TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      const agent = repo.create({ spaceId: 'space-1', name: 'Shared' });
      db.prepare(
        `UPDATE space_long_horizon_agents SET template_key = 'coordinator.default' WHERE id = ?`
      ).run(agent.id);
      db.prepare(
        `INSERT INTO space_agent_inbox_messages
         (id, space_id, target_agent_id, source_actor_id, message, expires_at, created_at)
         VALUES ('in-1', 'space-1', ?, 'src', 'hello', 9999, 1)`
      ).run(agent.id);

      repo.delete(agent.id);

      expect(repo.getById(agent.id)).toBeNull();
      const row = unifiedRow(agent.id);
      expect(row).toBeDefined();
      expect(row?.template_key).toBe('coordinator.default');
      const inbox = db
        .prepare(`SELECT COUNT(*) AS n FROM space_agent_inbox_messages WHERE target_agent_id = ?`)
        .get(agent.id) as { n: number };
      expect(inbox.n).toBe(1);
    });
  });
});
