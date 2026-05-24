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
