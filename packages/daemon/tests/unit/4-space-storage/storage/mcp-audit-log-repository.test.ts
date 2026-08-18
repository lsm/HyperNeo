import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('McpAuditLogRepository', () => {
  let db: Database;
  let repo: McpAuditLogRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    repo = new McpAuditLogRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  describe('createEntry', () => {
    it('creates an entry with all fields', () => {
      const entry = repo.createEntry({
        agentName: 'coder',
        sessionId: 'sess-1',
        toolName: 'send_message',
        paramsSummary: JSON.stringify({ target: 'reviewer' }),
        spaceId: 'space-1',
        taskId: 'task-1',
        workflowRunId: 'run-1',
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.agentName).toBe('coder');
      expect(entry.sessionId).toBe('sess-1');
      expect(entry.toolName).toBe('send_message');
      expect(entry.paramsSummary).toBe(JSON.stringify({ target: 'reviewer' }));
      expect(entry.spaceId).toBe('space-1');
      expect(entry.taskId).toBe('task-1');
      expect(entry.workflowRunId).toBe('run-1');
    });

    it('creates an entry with minimal fields', () => {
      const entry = repo.createEntry({
        toolName: 'save_artifact',
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.agentName).toBeNull();
      expect(entry.sessionId).toBeNull();
      expect(entry.toolName).toBe('save_artifact');
      expect(entry.paramsSummary).toBeNull();
      expect(entry.spaceId).toBeNull();
      expect(entry.taskId).toBeNull();
      expect(entry.workflowRunId).toBeNull();
    });

    it('stores null for undefined optional fields', () => {
      const entry = repo.createEntry({
        agentName: undefined,
        sessionId: undefined,
        toolName: 'approve_task',
        paramsSummary: undefined,
        spaceId: undefined,
        taskId: undefined,
        workflowRunId: undefined,
      });

      expect(entry.agentName).toBeNull();
      expect(entry.sessionId).toBeNull();
      expect(entry.paramsSummary).toBeNull();
      expect(entry.spaceId).toBeNull();
      expect(entry.taskId).toBeNull();
      expect(entry.workflowRunId).toBeNull();
    });
  });

  describe('listBySpace', () => {
    it('returns entries for the given space', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-b' });

      const results = repo.listBySpace('space-a');
      expect(results).toHaveLength(2);
      const toolNames = results.map((e) => e.toolName);
      expect(toolNames).toContain('t1');
      expect(toolNames).toContain('t2');
    });

    it('returns empty array when no entries match', () => {
      const results = repo.listBySpace('nonexistent');
      expect(results).toEqual([]);
    });

    it('respects limit and offset', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-a' });

      const all = repo.listBySpace('space-a');
      expect(all).toHaveLength(3);

      const page1 = repo.listBySpace('space-a', 2, 0);
      expect(page1).toHaveLength(2);

      const page2 = repo.listBySpace('space-a', 2, 2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('listByTask', () => {
    it('returns entries for the given task', () => {
      repo.createEntry({ toolName: 't1', taskId: 'task-a' });
      repo.createEntry({ toolName: 't2', taskId: 'task-a' });
      repo.createEntry({ toolName: 't3', taskId: 'task-b' });

      const results = repo.listByTask('task-a');
      expect(results).toHaveLength(2);
      const toolNames = results.map((e) => e.toolName);
      expect(toolNames).toContain('t1');
      expect(toolNames).toContain('t2');
    });

    it('returns empty array when no entries match', () => {
      const results = repo.listByTask('nonexistent');
      expect(results).toEqual([]);
    });

    it('respects limit and offset', () => {
      repo.createEntry({ toolName: 't1', taskId: 'task-a' });
      repo.createEntry({ toolName: 't2', taskId: 'task-a' });
      repo.createEntry({ toolName: 't3', taskId: 'task-a' });

      const all = repo.listByTask('task-a');
      expect(all).toHaveLength(3);

      const page1 = repo.listByTask('task-a', 2, 0);
      expect(page1).toHaveLength(2);

      const page2 = repo.listByTask('task-a', 2, 2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('listBySession', () => {
    it('returns entries for the given session', () => {
      repo.createEntry({ toolName: 't1', sessionId: 'sess-a' });
      repo.createEntry({ toolName: 't2', sessionId: 'sess-a' });
      repo.createEntry({ toolName: 't3', sessionId: 'sess-b' });

      const results = repo.listBySession('sess-a');
      expect(results).toHaveLength(2);
      const toolNames = results.map((e) => e.toolName);
      expect(toolNames).toContain('t1');
      expect(toolNames).toContain('t2');
    });

    it('returns empty array when no entries match', () => {
      const results = repo.listBySession('nonexistent');
      expect(results).toEqual([]);
    });

    it('respects limit and offset', () => {
      repo.createEntry({ toolName: 't1', sessionId: 'sess-a' });
      repo.createEntry({ toolName: 't2', sessionId: 'sess-a' });
      repo.createEntry({ toolName: 't3', sessionId: 'sess-a' });

      const all = repo.listBySession('sess-a');
      expect(all).toHaveLength(3);

      const page1 = repo.listBySession('sess-a', 2, 0);
      expect(page1).toHaveLength(2);

      const page2 = repo.listBySession('sess-a', 2, 2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('countBySpace', () => {
    it('returns the total count of entries for a space', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-b' });

      expect(repo.countBySpace('space-a')).toBe(2);
      expect(repo.countBySpace('space-b')).toBe(1);
    });

    it('returns 0 when no entries match', () => {
      expect(repo.countBySpace('nonexistent')).toBe(0);
    });
  });

  describe('countByTask', () => {
    it('returns the total count of entries for a task', () => {
      repo.createEntry({ toolName: 't1', taskId: 'task-a' });
      repo.createEntry({ toolName: 't2', taskId: 'task-a' });
      repo.createEntry({ toolName: 't3', taskId: 'task-b' });

      expect(repo.countByTask('task-a')).toBe(2);
      expect(repo.countByTask('task-b')).toBe(1);
    });

    it('returns 0 when no entries match', () => {
      expect(repo.countByTask('nonexistent')).toBe(0);
    });
  });

  describe('countBySession', () => {
    it('returns the total count of entries for a session', () => {
      repo.createEntry({ toolName: 't1', sessionId: 'sess-a' });
      repo.createEntry({ toolName: 't2', sessionId: 'sess-a' });
      repo.createEntry({ toolName: 't3', sessionId: 'sess-b' });

      expect(repo.countBySession('sess-a')).toBe(2);
      expect(repo.countBySession('sess-b')).toBe(1);
    });

    it('returns 0 when no entries match', () => {
      expect(repo.countBySession('nonexistent')).toBe(0);
    });
  });

  describe('listByTaskAndSpace', () => {
    it('returns only entries matching both task and space', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a', taskId: 'task-x' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a', taskId: 'task-x' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-b', taskId: 'task-x' });

      const results = repo.listByTaskAndSpace('task-x', 'space-a');
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.spaceId === 'space-a')).toBe(true);
    });
  });

  describe('listBySessionAndSpace', () => {
    it('returns only entries matching both session and space', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a', sessionId: 'sess-x' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a', sessionId: 'sess-x' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-b', sessionId: 'sess-x' });

      const results = repo.listBySessionAndSpace('sess-x', 'space-a');
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.spaceId === 'space-a')).toBe(true);
    });
  });

  describe('countByTaskAndSpace', () => {
    it('counts only entries matching both task and space', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a', taskId: 'task-x' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a', taskId: 'task-x' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-b', taskId: 'task-x' });

      expect(repo.countByTaskAndSpace('task-x', 'space-a')).toBe(2);
      expect(repo.countByTaskAndSpace('task-x', 'space-b')).toBe(1);
    });
  });

  describe('countBySessionAndSpace', () => {
    it('counts only entries matching both session and space', () => {
      repo.createEntry({ toolName: 't1', spaceId: 'space-a', sessionId: 'sess-x' });
      repo.createEntry({ toolName: 't2', spaceId: 'space-a', sessionId: 'sess-x' });
      repo.createEntry({ toolName: 't3', spaceId: 'space-b', sessionId: 'sess-x' });

      expect(repo.countBySessionAndSpace('sess-x', 'space-a')).toBe(2);
      expect(repo.countBySessionAndSpace('sess-x', 'space-b')).toBe(1);
    });
  });
});
