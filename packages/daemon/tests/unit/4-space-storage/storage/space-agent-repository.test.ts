/**
 * SpaceAgentRepository Unit Tests
 *
 * Tests for CRUD operations, JSON serialization, batch lookup, deletion protection,
 * and the DB-level name uniqueness check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import {
  createSpaceAgentSchema,
  createWorkflowPinningTables,
  insertDefinitionVersion,
  insertRunTask,
  insertSpace,
  insertWorkflow,
  insertWorkflowNode,
  insertWorkflowRun,
} from '../../helpers/space-agent-schema';

describe('SpaceAgentRepository', () => {
  let db: Database;
  let repo: SpaceAgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    createWorkflowPinningTables(db);
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
      // Upgraded DBs may store tools = '' (the m151 migration explicitly handles
      // that value). rowToAgent must not call JSON.parse('') and throw.
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
      // Same name, same id — should not count as taken
      expect(repo.isNameTaken('space-1', 'Coder', agent.id)).toBe(false);
    });

    it('is scoped to the space', () => {
      insertSpace(db, 'space-2');
      repo.create({ spaceId: 'space-1', name: 'Coder' });
      // Name exists in space-1 but not space-2
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

  describe('isReferencedByActivePinnedRun', () => {
    it('returns not-referenced when no runs or versions exist', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      const result = repo.isReferencedByActivePinnedRun(agent.id);
      expect(result.referenced).toBe(false);
      expect(result.runIds).toEqual([]);
    });

    it('returns not-referenced when a run is pinned to a version that does not reference the agent', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      // Version references some OTHER agent id, not this one.
      insertWorkflow(db, 'wf-1', 'space-1', 'Deploy');
      insertDefinitionVersion(db, 'wf-1', 'hash-1', 'other-agent-id');
      insertWorkflowRun(db, 'run-1', 'wf-1', 'hash-1');
      insertRunTask(db, 'task-1', 'run-1');

      const result = repo.isReferencedByActivePinnedRun(agent.id);
      expect(result.referenced).toBe(false);
      expect(result.runIds).toEqual([]);
    });

    it('returns referenced when a non-archived run is pinned to a version referencing the agent', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      insertWorkflow(db, 'wf-1', 'space-1', 'Deploy');
      insertDefinitionVersion(db, 'wf-1', 'hash-1', agent.id);
      insertWorkflowRun(db, 'run-1', 'wf-1', 'hash-1');
      insertRunTask(db, 'task-1', 'run-1');

      const result = repo.isReferencedByActivePinnedRun(agent.id);
      expect(result.referenced).toBe(true);
      expect(result.runIds).toContain('run-1');
    });

    it('returns not-referenced when the only run pinned to a referencing version is archived (tombstone)', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      insertWorkflow(db, 'wf-1', 'space-1', 'Deploy');
      insertDefinitionVersion(db, 'wf-1', 'hash-1', agent.id);
      insertWorkflowRun(db, 'run-1', 'wf-1', 'hash-1');
      // Fully archived → the run can never execute again, so the pin is inert.
      insertRunTask(db, 'task-1', 'run-1', true);

      const result = repo.isReferencedByActivePinnedRun(agent.id);
      expect(result.referenced).toBe(false);
      expect(result.runIds).toEqual([]);
    });

    it('returns not-referenced for an unpinned run that references the agent only in the head', () => {
      // An unpinned run (definition_version NULL) re-reads the mutable head, so
      // it is isAgentReferenced's concern, not this predicate's.
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      insertWorkflow(db, 'wf-1', 'space-1', 'Deploy');
      insertDefinitionVersion(db, 'wf-1', 'hash-1', agent.id);
      insertWorkflowRun(db, 'run-1', 'wf-1', null);
      insertRunTask(db, 'task-1', 'run-1');

      const result = repo.isReferencedByActivePinnedRun(agent.id);
      expect(result.referenced).toBe(false);
      expect(result.runIds).toEqual([]);
    });

    it('counts a run whose canonical task is live even alongside archived duplicates', () => {
      const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
      insertWorkflow(db, 'wf-1', 'space-1', 'Deploy');
      insertDefinitionVersion(db, 'wf-1', 'hash-1', agent.id);
      insertWorkflowRun(db, 'run-1', 'wf-1', 'hash-1');
      insertRunTask(db, 'task-archived', 'run-1', true);
      insertRunTask(db, 'task-live', 'run-1', false);

      const result = repo.isReferencedByActivePinnedRun(agent.id);
      expect(result.referenced).toBe(true);
      expect(result.runIds).toContain('run-1');
    });
  });
});
