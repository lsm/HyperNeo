import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { AgentMemoryRepository } from '../../../../src/storage/repositories/agent-memory-repository.ts';
import { createAgentMemoryToolHandlers } from '../../../../src/lib/space/tools/agent-memory-tools.ts';

let db: BunDatabase;
let repo: AgentMemoryRepository;

function seedSpace(spaceId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	     allowed_models, session_ids, slug, status, created_at, updated_at)
	     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/${spaceId}`, spaceId, spaceId, now, now);
}

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('agent memory MCP tool handlers', () => {
  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    repo = new AgentMemoryRepository(db);
    seedSpace('space-a');
  });

  afterEach(() => {
    db.close();
  });

  test('writes and retrieves memory within same space', async () => {
    const handlers = createAgentMemoryToolHandlers({
      spaceId: 'space-a',
      memoryRepo: repo,
      mySessionId: 'session-1',
    });

    const write = parseResult(
      await handlers['memory.write']({
        key: 'decision.build',
        content: 'Use make build for web bundle verification.',
        tags: ['build'],
      })
    );
    expect(write.success).toBe(true);

    const search = parseResult(
      await handlers['memory.search']({ query: 'bundle verification', limit: 5 })
    );
    const results = search.results as Array<{ memory: { key: string; createdBySession: string } }>;
    expect(results[0].memory.key).toBe('decision.build');
    expect(results[0].memory.createdBySession).toBe('session-1');

    const read = parseResult(await handlers['memory.read']({ key: 'decision.build' }));
    expect((read.memory as { content: string }).content).toContain('make build');
  });

  test('memory.write preserves existing tags when caller omits tags', async () => {
    const handlers = createAgentMemoryToolHandlers({
      spaceId: 'space-a',
      memoryRepo: repo,
      mySessionId: 'session-1',
    });

    await handlers['memory.write']({
      key: 'decision.format',
      content: 'Initial decision.',
      tags: ['formatting', 'biome'],
    });

    const update = parseResult(
      await handlers['memory.write']({
        key: 'decision.format',
        content: 'Updated decision body.',
      })
    );
    const memory = update.memory as { tags: string[] };
    expect(memory.tags).toEqual(['formatting', 'biome']);
  });
});

describe('agent memory MCP tool owner namespacing', () => {
  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    repo = new AgentMemoryRepository(db);
    seedSpace('space-a');
  });

  afterEach(() => {
    db.close();
  });

  function handlersFor(ownerAgentId?: string) {
    return createAgentMemoryToolHandlers({
      spaceId: 'space-a',
      memoryRepo: repo,
      mySessionId: 'session-agent',
      ownerAgentId,
    });
  }

  test('writes default to agent-scoped when ownerAgentId is configured', async () => {
    const write = parseResult(
      await handlersFor('agent-a')['memory.write']({
        key: 'pref.color',
        content: 'Agent A likes teal.',
      })
    );
    const memory = write.memory as { ownerAgentId: string | null; scope: string };
    expect(memory.ownerAgentId).toBe('agent-a');
    expect(memory.scope).toBe('agent');
  });

  test('two agents with the same key each keep their own memory', async () => {
    const a = handlersFor('agent-a');
    const b = handlersFor('agent-b');
    await a['memory.write']({ key: 'note', content: 'A note.' });
    await b['memory.write']({ key: 'note', content: 'B note.' });

    const aRead = parseResult(await a['memory.read']({ key: 'note' })) as {
      memory: { content: string };
    };
    const bRead = parseResult(await b['memory.read']({ key: 'note' })) as {
      memory: { content: string };
    };
    expect(aRead.memory.content).toBe('A note.');
    expect(bRead.memory.content).toBe('B note.');
  });

  test('explicit scope=space writes to the shared pool', async () => {
    const write = parseResult(
      await handlersFor('agent-a')['memory.write']({
        key: 'shared.fact',
        content: 'Common knowledge.',
        scope: 'space',
      })
    );
    const memory = write.memory as { ownerAgentId: string | null; scope: string };
    expect(memory.scope).toBe('space');
    expect(memory.ownerAgentId).toBeNull();
  });

  test('search default returns agent + shared, not other agents', async () => {
    await handlersFor('agent-a')['memory.write']({ key: 'a.deploy', content: 'A deploy note.' });
    await handlersFor('agent-b')['memory.write']({ key: 'b.deploy', content: 'B deploy note.' });
    // A shared row visible to everyone.
    await createAgentMemoryToolHandlers({
      spaceId: 'space-a',
      memoryRepo: repo,
    })['memory.write']({ key: 'shared.deploy', content: 'Shared deploy note.' });

    const results = parseResult(
      await handlersFor('agent-a')['memory.search']({ query: 'deploy', limit: 10 })
    );
    const keys = (results.results as Array<{ memory: { key: string } }>).map((r) => r.memory.key);
    expect(keys.sort()).toEqual(['a.deploy', 'shared.deploy']);
  });

  test('scope=all search returns every memory in the space', async () => {
    await handlersFor('agent-a')['memory.write']({ key: 'a.deploy', content: 'A deploy note.' });
    await handlersFor('agent-b')['memory.write']({ key: 'b.deploy', content: 'B deploy note.' });

    const results = parseResult(
      await handlersFor('agent-a')['memory.search']({ query: 'deploy', limit: 10, scope: 'all' })
    );
    const keys = (results.results as Array<{ memory: { key: string } }>).map((r) => r.memory.key);
    expect(keys.sort()).toEqual(['a.deploy', 'b.deploy']);
  });

  test('delete does not remove another agent private memory', async () => {
    await handlersFor('agent-a')['memory.write']({ key: 'note', content: 'A private.' });
    // Agent B deletes the same key (default mine + space) — must not touch A.
    const deleted = parseResult(await handlersFor('agent-b')['memory.delete']({ key: 'note' }));
    expect(deleted.deleted).toBe(false);

    const aRead = parseResult(await handlersFor('agent-a')['memory.read']({ key: 'note' })) as {
      memory?: { content: string };
    };
    expect(aRead.memory?.content).toBe('A private.');
  });

  test('tool without ownerAgentId cannot see agent-scoped memory', async () => {
    await handlersFor('agent-a')['memory.write']({ key: 'secret', content: 'A private.' });

    const plain = createAgentMemoryToolHandlers({ spaceId: 'space-a', memoryRepo: repo });
    const read = parseResult(await plain['memory.read']({ key: 'secret' })) as { success: boolean };
    expect(read.success).toBe(false);
  });
});
