import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import {
  AgentMemoryRepository,
  type AgentMemoryEmbedder,
} from '../../../src/storage/repositories/agent-memory-repository.ts';

let db: BunDatabase;
let repo: AgentMemoryRepository;

class KeywordEmbedder implements AgentMemoryEmbedder {
  model = 'test-keyword';
  dimensions = 3;

  embedQuery(text: string): Float32Array {
    return keywordVector(text);
  }

  embedPassage(text: string): Float32Array {
    return keywordVector(text);
  }
}

class TrackingEmbedder extends KeywordEmbedder {
  queryTexts: string[] = [];
  passageTexts: string[] = [];

  override embedQuery(text: string): Float32Array {
    this.queryTexts.push(text);
    return super.embedQuery(text);
  }

  override embedPassage(text: string): Float32Array {
    this.passageTexts.push(text);
    return super.embedPassage(text);
  }
}

class AsyncKeywordEmbedder implements AgentMemoryEmbedder {
  model = 'test-keyword';
  dimensions = 3;

  embedQuery(text: string): Promise<Float32Array> {
    return Promise.resolve(keywordVector(text));
  }

  embedPassage(text: string): Promise<Float32Array> {
    return Promise.resolve(keywordVector(text));
  }
}

class DeferredKeywordEmbedder implements AgentMemoryEmbedder {
  model = 'test-keyword';
  dimensions = 3;
  private resolvers: Array<(vector: Float32Array) => void> = [];

  embedQuery(text: string): Promise<Float32Array> {
    return new Promise((resolve) => {
      this.resolvers.push(() => resolve(keywordVector(text)));
    });
  }

  embedPassage(text: string): Promise<Float32Array> {
    return new Promise((resolve) => {
      this.resolvers.push(() => resolve(keywordVector(text)));
    });
  }

  get pendingCount(): number {
    return this.resolvers.length;
  }

  resolveNext(): void {
    this.resolvers.shift()?.(new Float32Array());
  }
}

class FailingEmbedder implements AgentMemoryEmbedder {
  model = 'test-failing';
  dimensions = 3;
  passageCalls = 0;

  embedQuery(): Promise<Float32Array> {
    return Promise.reject(new Error('embedding unavailable'));
  }

  embedPassage(): Promise<Float32Array> {
    this.passageCalls++;
    return Promise.reject(new Error('embedding unavailable'));
  }
}

class FailingThenReadyEmbedder implements AgentMemoryEmbedder {
  model = 'test-failing-then-ready';
  dimensions = 3;
  passageInputs: string[] = [];

  embedQuery(): Float32Array {
    return new Float32Array([1, 0, 0]);
  }

  embedPassage(text: string): Float32Array {
    this.passageInputs.push(text);
    if (text.includes('fails')) throw new Error('content-specific embedding error');
    return new Float32Array([1, 0, 0]);
  }
}

class QueryFailingEmbedder extends KeywordEmbedder {
  override embedQuery(): Promise<Float32Array> {
    return Promise.reject(new Error('query embedding unavailable'));
  }
}

class SyncThrowingEmbedder extends KeywordEmbedder {
  override embedPassage(): Float32Array {
    throw new Error('sync embedding unavailable');
  }
}

function keywordVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  return new Float32Array([
    lower.includes('delete') || lower.includes('remove') || lower.includes('erase') ? 1 : 0,
    lower.includes('session') || lower.includes('conversation') || lower.includes('thread') ? 1 : 0,
    lower.includes('credential') || lower.includes('secret') || lower.includes('token') ? 1 : 0,
  ]);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function seedSpace(spaceId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
	     allowed_models, session_ids, slug, status, created_at, updated_at)
	     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/${spaceId}`, spaceId, spaceId, now, now);
}

describe('AgentMemoryRepository', () => {
  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    repo = new AgentMemoryRepository(db);
    seedSpace('space-a');
    seedSpace('space-b');
  });

  afterEach(() => {
    db.close();
  });

  test('writes and reads memory by space/key', async () => {
    const memory = repo.write({
      spaceId: 'space-a',
      key: 'conventions.test',
      content: 'Use Bun native tests for daemon code.',
      tags: ['testing', 'bun'],
      createdBySession: 'session-1',
    });

    expect(memory.key).toBe('conventions.test');
    expect(memory.spaceId).toBe('space-a');
    expect(memory.tags).toEqual(['testing', 'bun']);
    expect(await repo.list('space-a')).toHaveLength(1);

    const read = repo.read('space-a', 'conventions.test');
    expect(read?.content).toBe('Use Bun native tests for daemon code.');
    expect(read?.createdBySession).toBe('session-1');
  });

  test('create atomically inserts and rejects on a duplicate key', () => {
    repo.write({ spaceId: 'space-a', key: 'dup', content: 'first' });

    expect(() => repo.create({ spaceId: 'space-a', key: 'dup', content: 'second' })).toThrow(
      'already exists'
    );
    expect(repo.read('space-a', 'dup', { recordAccess: false })?.content).toBe('first');

    const created = repo.create({ spaceId: 'space-a', key: 'fresh', content: 'new' });
    expect(created.key).toBe('fresh');
    expect(repo.read('space-a', 'fresh', { recordAccess: false })?.content).toBe('new');
  });

  test('filtered list does not record access when recordAccess is false', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.access',
      content: 'Management reads must not bump access telemetry.',
      tags: ['telemetry'],
    });

    const readonly = await repo.list('space-a', {
      query: 'access telemetry',
      recordAccess: false,
    });
    expect(readonly).toHaveLength(1);

    let row = db
      .prepare(`SELECT access_count, last_accessed_at FROM space_agent_memory WHERE key = ?`)
      .get('conventions.access') as { access_count: number; last_accessed_at: number | null };
    expect(row.access_count).toBe(0);
    expect(row.last_accessed_at).toBeNull();

    await repo.list('space-a', { query: 'access telemetry' });
    row = db
      .prepare(`SELECT access_count FROM space_agent_memory WHERE key = ?`)
      .get('conventions.access') as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  test('search returns FTS-ranked results', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'alpha',
      content: 'React components use hooks.',
    });
    repo.write({
      spaceId: 'space-a',
      key: 'preact',
      content: 'Preact Signals are required for web state management.',
      tags: ['preact', 'signals'],
    });

    const results = await repo.search('space-a', 'preact signals', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.key).toBe('preact');
    expect(results[0].rank).toBeTypeOf('number');
  });

  test('search is scoped by space', async () => {
    repo.write({ spaceId: 'space-a', key: 'shared', content: 'Use tabs for formatting.' });
    repo.write({ spaceId: 'space-b', key: 'shared', content: 'Use spaces for formatting.' });

    const results = await repo.search('space-a', 'formatting', 10);
    expect(results.map((result) => result.memory.content)).toEqual(['Use tabs for formatting.']);
  });

  test('preserves tags with whitespace', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'release.process',
      content: 'Release process notes.',
      tags: ['release notes', 'phase 1'],
    });

    expect(repo.read('space-a', 'release.process')?.tags).toEqual(['release notes', 'phase 1']);
  });

  test('rejects oversized memory content', () => {
    expect(() =>
      repo.write({
        spaceId: 'space-a',
        key: 'oversized',
        content: 'x'.repeat(10_001),
      })
    ).toThrow('Memory content must be 10000 characters or fewer.');
  });

  test('rejects oversized memory tags', () => {
    expect(() =>
      repo.write({
        spaceId: 'space-a',
        key: 'oversized.tag',
        content: 'Tag length must be bounded for prompt safety.',
        tags: ['x'.repeat(51)],
      })
    ).toThrow('Memory tags must be 50 characters or fewer.');
  });

  test('preserves existing tags when update omits tags', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.api',
      content: 'Original content.',
      tags: ['api', 'http'],
    });

    const updated = repo.write({
      spaceId: 'space-a',
      key: 'conventions.api',
      content: 'Updated content without tag changes.',
    });

    expect(updated.content).toBe('Updated content without tag changes.');
    expect(updated.tags).toEqual(['api', 'http']);
  });

  test('clears tags when update explicitly passes empty array', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.lint',
      content: 'Original.',
      tags: ['lint'],
    });

    const updated = repo.write({
      spaceId: 'space-a',
      key: 'conventions.lint',
      content: 'Original.',
      tags: [],
    });

    expect(updated.tags).toEqual([]);
  });

  test('keeps original creator session when later sessions update', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.auth',
      content: 'Initial note.',
      createdBySession: 'session-original',
    });

    const updated = repo.write({
      spaceId: 'space-a',
      key: 'conventions.auth',
      content: 'Revised note.',
      createdBySession: 'session-later',
    });

    expect(updated.createdBySession).toBe('session-original');
  });

  test('search matches path identifiers', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'modules.entry',
      content: 'Entry point is src/lib/main.ts.',
    });

    const results = await repo.search('space-a', 'src/lib/main.ts', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['modules.entry']);
  });

  test('filtered list honors limit and offset above search limit', async () => {
    for (let index = 0; index < 25; index++) {
      repo.write({
        spaceId: 'space-a',
        key: `memory.${index.toString().padStart(2, '0')}`,
        content: `Shared pagination topic ${index}`,
      });
    }

    const firstPage = await repo.list('space-a', { query: 'pagination topic', limit: 25 });
    const secondPage = await repo.list('space-a', {
      query: 'pagination topic',
      limit: 5,
      offset: 5,
    });

    expect(firstPage).toHaveLength(25);
    expect(secondPage).toHaveLength(5);
    expect(secondPage.map((memory) => memory.key)).toEqual(
      firstPage.slice(5, 10).map((memory) => memory.key)
    );
  });

  test('search orders by FTS rank before recency', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'focused',
      content: 'Preact preact preact signals signals signals.',
    });
    repo.write({
      spaceId: 'space-a',
      key: 'recent',
      content: 'Preact signals mixed with unrelated routing and styling notes.',
    });

    const results = await repo.search('space-a', 'preact signals', 1);
    expect(results.map((result) => result.memory.key)).toEqual(['focused']);
    expect(results[0].rank).not.toBe(1000);
  });

  test('search matches hyphenated identifiers', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'tooling.hooks',
      content: 'Run pre-commit before pushing.',
    });

    const results = await repo.search('space-a', 'pre-commit', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['tooling.hooks']);
  });

  test('search matches memory keys', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.forms',
      content: 'Use zod schemas.',
    });

    const results = await repo.search('space-a', 'conventions.forms', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['conventions.forms']);
  });

  test('access updates do not rewrite FTS rows', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'access.fts',
      content: 'Keep access telemetry cheap.',
    });
    const before = db
      .prepare(`SELECT count(*) AS count FROM space_agent_memory_fts_data`)
      .get() as {
      count: number;
    };

    repo.read('space-a', 'access.fts');
    await repo.search('space-a', 'telemetry', 5);

    const after = db.prepare(`SELECT count(*) AS count FROM space_agent_memory_fts_data`).get() as {
      count: number;
    };
    expect(after.count).toBe(before.count);
  });

  test('delete removes memory from FTS index', async () => {
    repo.write({ spaceId: 'space-a', key: 'obsolete', content: 'Old Flowbite convention.' });
    expect(await repo.search('space-a', 'Flowbite', 10)).toHaveLength(1);

    expect(repo.delete('space-a', 'obsolete')).toBe(true);
    expect(repo.read('space-a', 'obsolete')).toBeNull();
    expect(await repo.search('space-a', 'Flowbite', 10)).toHaveLength(0);
  });

  test('semantic paraphrase query finds memory with zero keyword overlap', async () => {
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'cleanup.sessions',
      content: 'Delete stale session records after retention expires.',
    });
    repo.write({
      spaceId: 'space-a',
      key: 'auth.tokens',
      content: 'Store credential material only in secure storage.',
    });

    const vectorCount = db.prepare(`SELECT count(*) AS count FROM memory_vectors`).get() as {
      count: number;
    };
    const fkCheck = db.prepare(`PRAGMA foreign_key_check(memory_vectors)`).all();
    const results = await repo.search('space-a', 'erase old conversation data', 5);

    expect(vectorCount.count).toBe(2);
    expect(fkCheck).toEqual([]);
    expect(results.map((result) => result.memory.key)).toContain('cleanup.sessions');
    expect(results[0].memory.key).toBe('cleanup.sessions');
  });

  test('pending entries still appear in FTS results while embedding is incomplete', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'pending.memory',
      content: 'Pending embedding still searchable through lexical fallback.',
    });

    const row = db
      .prepare(`SELECT embedding_status FROM space_agent_memory WHERE space_id = ? AND key = ?`)
      .get('space-a', 'pending.memory') as { embedding_status: string };
    expect(row.embedding_status).toBe('pending');
    const results = await repo.search('space-a', 'lexical fallback', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['pending.memory']);
  });

  test('query embedding failures fall back to FTS results', async () => {
    repo = new AgentMemoryRepository(db, undefined, new QueryFailingEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'fallback.memory',
      content: 'Lexical fallback survives query embedding failure.',
    });

    const results = await repo.search('space-a', 'lexical fallback', 5);

    expect(results.map((result) => result.memory.key)).toEqual(['fallback.memory']);
  });

  test('sync passage embedding failures do not abort writes', () => {
    repo = new AgentMemoryRepository(db, undefined, new SyncThrowingEmbedder());
    const memory = repo.write({
      spaceId: 'space-a',
      key: 'sync.failure',
      content: 'Synchronous embedding failures should keep lexical memory.',
    });

    expect(memory.key).toBe('sync.failure');
    const row = db
      .prepare(
        `SELECT embedding_status, embedding_error FROM space_agent_memory WHERE space_id = ? AND key = ?`
      )
      .get('space-a', 'sync.failure') as {
      embedding_status: string;
      embedding_error: string;
    };
    expect(row.embedding_status).toBe('failed');
    expect(row.embedding_error).toContain('sync embedding unavailable');
  });

  test('uses passage embeddings for memories and query embeddings for searches', async () => {
    const embedder = new TrackingEmbedder();
    repo = new AgentMemoryRepository(db, undefined, embedder);
    repo.write({
      spaceId: 'space-a',
      key: 'embedding.kind',
      content: 'Delete stale session records after retention expires.',
    });

    await repo.search('space-a', 'erase old conversation data', 5);

    expect(embedder.passageTexts).toEqual([
      'embedding.kind\nDelete stale session records after retention expires.',
    ]);
    expect(embedder.queryTexts).toEqual(['erase old conversation data']);
  });

  test('backfills pending legacy memories', async () => {
    repo.write({
      spaceId: 'space-a',
      key: 'legacy.memory',
      content: 'Delete stale session records after retention expires.',
    });
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());

    repo.backfillPendingEmbeddings();

    const results = await repo.search('space-a', 'erase old conversation data', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['legacy.memory']);
  });

  test('vector search preserves space isolation', async () => {
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'cleanup.local',
      content: 'Delete stale session records after retention expires.',
    });
    repo.write({
      spaceId: 'space-b',
      key: 'cleanup.other',
      content: 'Delete stale session records after retention expires.',
    });

    const results = await repo.search('space-a', 'erase old conversation data', 5);

    expect(results.map((result) => result.memory.key)).toEqual(['cleanup.local']);
  });

  test('semantic search awaits async query embeddings', async () => {
    repo = new AgentMemoryRepository(db, undefined, new AsyncKeywordEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'cleanup.async',
      content: 'Delete stale session records after retention expires.',
    });
    await flushPromises();

    const results = await repo.search('space-a', 'erase old conversation data', 5);

    expect(results.map((result) => result.memory.key)).toEqual(['cleanup.async']);
  });

  test('stale async embeddings do not overwrite newer content', async () => {
    const embedder = new DeferredKeywordEmbedder();
    repo = new AgentMemoryRepository(db, undefined, embedder);
    db.transaction(() => {
      repo.write({
        spaceId: 'space-a',
        key: 'changing.memory',
        content: 'Delete stale session records after retention expires.',
      });
      repo.write({
        spaceId: 'space-a',
        key: 'changing.memory',
        content: 'Store credential material only in secure storage.',
      });
    })();

    embedder.resolveNext();
    await flushPromises();
    embedder.resolveNext();
    await flushPromises();
    embedder.resolveNext();

    const vectorRow = db
      .prepare(`SELECT embedding FROM memory_vectors WHERE memory_id = 1`)
      .get() as {
      embedding: Buffer;
    };
    expect(new Float32Array(vectorRow.embedding.buffer, vectorRow.embedding.byteOffset, 3)).toEqual(
      keywordVector('Store credential material only in secure storage.')
    );
    const row = db
      .prepare(`SELECT embedding_revision FROM space_agent_memory WHERE space_id = ? AND key = ?`)
      .get('space-a', 'changing.memory') as { embedding_revision: number };
    expect(row.embedding_revision).toBe(2);
  });

  test('stale async embeddings do not write to a reused row id', async () => {
    const embedder = new DeferredKeywordEmbedder();
    repo = new AgentMemoryRepository(db, undefined, embedder);
    repo.write({
      spaceId: 'space-a',
      key: 'deleted.memory',
      content: 'Delete stale session records after retention expires.',
    });
    repo.delete('space-a', 'deleted.memory');
    repo.write({
      spaceId: 'space-a',
      key: 'new.memory',
      content: 'Store credential material only in secure storage.',
    });

    embedder.resolveNext();
    await flushPromises();
    embedder.resolveNext();
    await flushPromises();
    embedder.resolveNext();

    const row = db
      .prepare(
        `SELECT id, embedding_revision FROM space_agent_memory WHERE space_id = ? AND key = ?`
      )
      .get('space-a', 'new.memory') as { id: number; embedding_revision: number };
    expect(row.id).toBe(1);
    expect(row.embedding_revision).toBe(1);
    const vectorRow = db
      .prepare(`SELECT embedding FROM memory_vectors WHERE memory_id = ?`)
      .get(row.id) as { embedding: Buffer };
    expect(new Float32Array(vectorRow.embedding.buffer, vectorRow.embedding.byteOffset, 3)).toEqual(
      keywordVector('Store credential material only in secure storage.')
    );
  });

  test('embedding failures are persisted', async () => {
    repo = new AgentMemoryRepository(db, undefined, new FailingEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'failing.memory',
      content: 'Embedding provider failure should be visible.',
    });
    await flushPromises();

    const row = db
      .prepare(
        `SELECT embedding_status, embedding_error FROM space_agent_memory WHERE space_id = ? AND key = ?`
      )
      .get('space-a', 'failing.memory') as {
      embedding_status: string;
      embedding_error: string;
    };
    expect(row.embedding_status).toBe('failed');
    expect(row.embedding_error).toContain('embedding unavailable');
  });

  test('semantic search skips vectors from different embedding models', async () => {
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'cleanup.model',
      content: 'Delete stale session records after retention expires.',
    });
    db.prepare(`UPDATE memory_vectors SET model = ? WHERE memory_id = 1`).run('old-model');

    const results = await repo.search('space-a', 'erase old conversation data', 5);

    expect(results).toHaveLength(0);
  });

  test('backfills ready memories from older embedding models', async () => {
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'cleanup.old-model',
      content: 'Delete stale session records after retention expires.',
    });
    db.prepare(`UPDATE memory_vectors SET model = ? WHERE memory_id = 1`).run('old-model');
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());

    repo.backfillPendingEmbeddings();

    const results = await repo.search('space-a', 'erase old conversation data', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['cleanup.old-model']);
  });

  test('backfills failed memories after embedding provider recovers', async () => {
    repo = new AgentMemoryRepository(db, undefined, new FailingEmbedder());
    repo.write({
      spaceId: 'space-a',
      key: 'cleanup.failed',
      content: 'Delete stale session records after retention expires.',
    });
    await flushPromises();
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());

    repo.backfillPendingEmbeddings();

    const results = await repo.search('space-a', 'erase old conversation data', 5);
    expect(results.map((result) => result.memory.key)).toEqual(['cleanup.failed']);
  });

  test('startup backfill queues pending embeddings in batches', async () => {
    repo = new AgentMemoryRepository(db);
    for (let index = 0; index < 30; index++) {
      repo.write({
        spaceId: 'space-a',
        key: `backfill.${index.toString().padStart(2, '0')}`,
        content: `Backfill pending memory ${index}.`,
      });
    }
    const embedder = new DeferredKeywordEmbedder();
    db.prepare(
      `UPDATE space_agent_memory
			 SET embedding_status = 'ready'
			 WHERE key >= ?`
    ).run('backfill.25');
    db.prepare(
      `INSERT INTO memory_vectors (memory_id, embedding, dimensions, model, updated_at)
			 SELECT id, ?, 3, ?, ? FROM space_agent_memory WHERE key >= ?`
    ).run(
      Buffer.from(new Float32Array([0, 0, 0]).buffer),
      embedder.model,
      Date.now(),
      'backfill.25'
    );
    repo = new AgentMemoryRepository(db, undefined, embedder);

    repo.backfillPendingEmbeddings();
    await flushPromises();

    expect(embedder.pendingCount).toBe(1);
    for (let index = 0; index < 24; index++) {
      embedder.resolveNext();
      await flushPromises();
    }
    expect(embedder.pendingCount).toBe(1);
  });

  test('startup backfill retries failed rows only once per pass', async () => {
    const embedder = new FailingEmbedder();
    repo = new AgentMemoryRepository(db, undefined, embedder);
    repo.write({
      spaceId: 'space-a',
      key: 'backfill.failed.once',
      content: 'Delete stale session records after retention expires.',
    });
    await flushPromises();
    expect(embedder.passageCalls).toBe(1);

    repo.backfillPendingEmbeddings();
    await flushPromises();

    expect(embedder.passageCalls).toBe(2);
  });

  test('startup backfill advances past failed rows in the same pass', async () => {
    const embedder = new FailingThenReadyEmbedder();
    repo = new AgentMemoryRepository(db, undefined, embedder);
    const now = Date.now();
    const insertMemory = db.prepare(
      `INSERT INTO space_agent_memory
				(key, space_id, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at, embedding_status, embedding_model, embedding_updated_at, embedding_error, embedding_revision, embedding_token)
			 VALUES (?, 'space-a', ?, '[]', NULL, ?, ?, 0, NULL, ?, NULL, NULL, NULL, 1, ?)`
    );
    for (let index = 0; index < 25; index++) {
      insertMemory.run(
        `failed.${index.toString().padStart(2, '0')}`,
        `This content fails ${index}`,
        now,
        now + index,
        'failed',
        `failed-token-${index}`
      );
    }
    insertMemory.run(
      'later.pending',
      'This later memory can embed successfully.',
      now,
      now + 25,
      'pending',
      'later-token'
    );

    repo.backfillPendingEmbeddings();
    for (let index = 0; index < 30; index++) await flushPromises();

    expect(embedder.passageInputs).toHaveLength(26);
    expect(embedder.passageInputs.at(-1)).toContain('later.pending');
    const row = db
      .prepare(`SELECT embedding_status FROM space_agent_memory WHERE key = 'later.pending'`)
      .get() as { embedding_status: string };
    expect(row.embedding_status).toBe('ready');
  });

  test('vector search ranks ready vectors beyond the first 100 rows', async () => {
    repo = new AgentMemoryRepository(db, undefined, new KeywordEmbedder());
    for (let index = 0; index < 120; index++) {
      repo.write({
        spaceId: 'space-a',
        key: `memory.${index.toString().padStart(3, '0')}`,
        content:
          index === 119
            ? 'Delete stale session records after retention expires.'
            : `Unrelated memory ${index}`,
      });
    }

    const results = await repo.search('space-a', 'erase old conversation data', 5);

    expect(results.map((result) => result.memory.key)).toContain('memory.119');
  });

  test('filtered list supports offsets beyond 100 matches', async () => {
    for (let index = 0; index < 130; index++) {
      repo.write({
        spaceId: 'space-a',
        key: `pagination.${index.toString().padStart(3, '0')}`,
        content: `Shared pagination topic ${index}`,
      });
    }

    const page = await repo.list('space-a', { query: 'pagination topic', limit: 10, offset: 110 });

    expect(page).toHaveLength(10);
  });

  test('consolidation merges duplicate memories and combines access counts', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.forms',
      content: 'Use zod schemas for form validation.',
      tags: ['forms'],
    });
    repo.write({
      spaceId: 'space-a',
      key: 'conventions.forms.copy',
      content: 'Use zod schemas for form validation.',
      tags: ['validation'],
    });
    repo.recordAccess('space-a', 'conventions.forms');
    repo.recordAccess('space-a', 'conventions.forms.copy');
    repo.recordAccess('space-a', 'conventions.forms.copy');

    const result = repo.consolidate({ spaceId: 'space-a', staleTtlMs: 0 });
    const memories = db
      .prepare(`SELECT key, access_count, tags FROM space_agent_memory WHERE space_id = ?`)
      .all('space-a') as Array<{ key: string; access_count: number; tags: string }>;

    expect(result.duplicatesMerged).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0].access_count).toBe(3);
    expect(JSON.parse(memories[0].tags)).toEqual(['validation', 'forms']);
  });

  test('consolidation bounds oversized merged memory content', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'long.a',
      content: `shared duplicate marker ${'a'.repeat(5_980)}`,
    });
    repo.write({
      spaceId: 'space-a',
      key: 'long.b',
      content: `shared duplicate marker ${'b'.repeat(5_980)}`,
    });

    const result = repo.consolidate({
      spaceId: 'space-a',
      staleTtlMs: 0,
      duplicateJaccardThreshold: 0.5,
    });
    const memories = db
      .prepare(`SELECT content FROM space_agent_memory WHERE space_id = ?`)
      .all('space-a') as Array<{ content: string }>;

    expect(result.duplicatesMerged).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0].content.length).toBeLessThanOrEqual(10_000);
    expect(memories[0].content.endsWith('…')).toBe(true);
  });

  test('consolidation accumulates fields across multiple duplicate merges', () => {
    repo.write({
      spaceId: 'space-a',
      key: 'dup.a',
      content: 'Use zod schemas for form validation.',
      tags: ['a'],
    });
    repo.write({
      spaceId: 'space-a',
      key: 'dup.b',
      content: 'Use zod schemas for form validation and submit checks.',
      tags: ['b'],
    });
    repo.write({
      spaceId: 'space-a',
      key: 'dup.c',
      content: 'Use zod schemas for form validation and error messages.',
      tags: ['c'],
    });
    repo.recordAccess('space-a', 'dup.a');
    repo.recordAccess('space-a', 'dup.b');
    repo.recordAccess('space-a', 'dup.c');

    repo.consolidate({ spaceId: 'space-a', staleTtlMs: 0, duplicateJaccardThreshold: 0.4 });
    const memories = db
      .prepare(`SELECT content, access_count, tags FROM space_agent_memory WHERE space_id = ?`)
      .all('space-a') as Array<{ content: string; access_count: number; tags: string }>;

    expect(memories).toHaveLength(1);
    expect(memories[0].access_count).toBe(3);
    expect(memories[0].content).toContain('submit checks');
    expect(memories[0].content).toContain('error messages');
    expect(JSON.parse(memories[0].tags).sort()).toEqual(['a', 'b', 'c']);
  });

  test('consolidation does not merge empty token memories', () => {
    repo.write({ spaceId: 'space-a', key: 'short.a', content: 'aa' });
    repo.write({ spaceId: 'space-a', key: 'short.b', content: 'bb' });

    const result = repo.consolidate({ spaceId: 'space-a', staleTtlMs: 0 });
    const memories = db
      .prepare(`SELECT key FROM space_agent_memory WHERE space_id = ? ORDER BY key ASC`)
      .all('space-a') as Array<{ key: string }>;

    expect(result.duplicatesMerged).toBe(0);
    expect(memories.map((memory) => memory.key)).toEqual(['short.a', 'short.b']);
  });

  test('consolidation leaves non-duplicate memories intact', async () => {
    repo.write({ spaceId: 'space-a', key: 'forms', content: 'Use zod schemas for forms.' });
    repo.write({ spaceId: 'space-a', key: 'deploy', content: 'Deploy releases from dev branch.' });

    const result = repo.consolidate({ spaceId: 'space-a', staleTtlMs: 0 });
    const memories = (await repo.list('space-a')).map((memory) => memory.key).sort();

    expect(result.duplicatesMerged).toBe(0);
    expect(memories).toEqual(['deploy', 'forms']);
  });

  test('listCoreMemories returns empty array when none are ranked', () => {
    repo.write({ spaceId: 'space-a', key: 'unaccessed', content: 'No core rank yet.' });

    expect(repo.listCoreMemories('space-a')).toEqual([]);
  });

  test('consolidation re-embeds merged memories', () => {
    const embedder = new TrackingEmbedder();
    repo = new AgentMemoryRepository(db, undefined, embedder);
    repo.write({ spaceId: 'space-a', key: 'dup.one', content: 'Use zod schemas for forms.' });
    repo.write({ spaceId: 'space-a', key: 'dup.two', content: 'Use zod schemas for forms.' });
    embedder.passageTexts = [];

    repo.consolidate({ spaceId: 'space-a', staleTtlMs: 0 });

    expect(embedder.passageTexts).toHaveLength(1);
    expect(embedder.passageTexts[0]).toContain('Use zod schemas for forms.');
  });

  test('consolidation ranks core memories by computed score', () => {
    repo.write({ spaceId: 'space-a', key: 'old.hot', content: 'Old high access.' });
    repo.write({ spaceId: 'space-a', key: 'newer.warm', content: 'Newer medium access.' });
    const now = Date.now();
    db.prepare(
      `UPDATE space_agent_memory SET access_count = ?, updated_at = ?, last_accessed_at = ? WHERE key = ?`
    ).run(100, now - 100 * 24 * 60 * 60 * 1000, now - 100 * 24 * 60 * 60 * 1000, 'old.hot');
    db.prepare(
      `UPDATE space_agent_memory SET access_count = ?, updated_at = ?, last_accessed_at = ? WHERE key = ?`
    ).run(10, now, now, 'newer.warm');

    repo.consolidate({ spaceId: 'space-a', coreLimit: 1, staleTtlMs: 0 });
    const core = repo.listCoreMemories('space-a', 5);

    expect(core.map((memory) => memory.key)).toEqual(['newer.warm']);
  });

  test('consolidation prunes stale memories after TTL expiry', () => {
    repo.write({ spaceId: 'space-a', key: 'old.memory', content: 'Outdated convention.' });
    repo.write({ spaceId: 'space-a', key: 'fresh.memory', content: 'Current convention.' });
    const now = Date.now();
    db.prepare(
      `UPDATE space_agent_memory SET created_at = ?, updated_at = ?, last_accessed_at = NULL WHERE key = ?`
    ).run(now - 1000, now - 1000, 'old.memory');
    db.prepare(
      `UPDATE space_agent_memory SET created_at = ?, updated_at = ?, last_accessed_at = NULL WHERE key = ?`
    ).run(now, now, 'fresh.memory');

    const result = repo.consolidate({ spaceId: 'space-a', staleTtlMs: 500 });

    expect(result.memoriesPruned).toBe(1);
    expect(repo.read('space-a', 'old.memory', { recordAccess: false })).toBeNull();
    expect(repo.read('space-a', 'fresh.memory', { recordAccess: false })?.key).toBe('fresh.memory');
  });

  test('consolidation writes core memories from frequent recent access', () => {
    repo.write({ spaceId: 'space-a', key: 'rare.memory', content: 'Rarely used.' });
    repo.write({ spaceId: 'space-a', key: 'hot.memory', content: 'Frequently used.' });
    repo.recordAccess('space-a', 'rare.memory');
    repo.recordAccess('space-a', 'hot.memory');
    repo.recordAccess('space-a', 'hot.memory');

    const result = repo.consolidate({ spaceId: 'space-a', coreLimit: 1, staleTtlMs: 0 });
    const core = repo.listCoreMemories('space-a', 5);

    expect(result.coreMemoriesWritten).toBe(1);
    expect(core.map((memory) => memory.key)).toEqual(['hot.memory']);
    expect(core[0].score).toBeGreaterThan(0);
  });

  test('consolidation processes all spaces when spaceId is omitted', async () => {
    repo.write({ spaceId: 'space-a', key: 'dup.a1', content: 'Use bun tests for daemon code.' });
    repo.write({ spaceId: 'space-a', key: 'dup.a2', content: 'Use bun tests for daemon code.' });
    repo.write({ spaceId: 'space-b', key: 'dup.b1', content: 'Use preact signals for web state.' });
    repo.write({ spaceId: 'space-b', key: 'dup.b2', content: 'Use preact signals for web state.' });

    const result = repo.consolidate({ staleTtlMs: 0 });

    expect(result.spacesProcessed).toBe(2);
    expect(result.duplicatesMerged).toBe(2);
    expect(await repo.list('space-a')).toHaveLength(1);
    expect(await repo.list('space-b')).toHaveLength(1);
  });

  test('consolidation deletes stale memories in batches', async () => {
    const now = Date.now();
    for (let index = 0; index < 505; index++) {
      repo.write({
        spaceId: 'space-a',
        key: `old.${index.toString().padStart(3, '0')}`,
        content: `Old batched memory ${index}`,
      });
    }
    db.prepare(`UPDATE space_agent_memory SET updated_at = ?, last_accessed_at = NULL`).run(
      now - 10_000
    );

    const result = repo.consolidate({ spaceId: 'space-a', staleTtlMs: 1 });

    expect(result.memoriesPruned).toBe(505);
    expect(await repo.list('space-a', { limit: 25 })).toHaveLength(0);
  });

  test('filtered list keeps the default candidate pool for paginated hybrid ranking', async () => {
    for (let index = 0; index < 120; index++) {
      repo.write({
        spaceId: 'space-a',
        key: `hybrid.${index.toString().padStart(3, '0')}`,
        content: `Hybrid pagination topic ${index}`,
      });
    }

    const fullPage = await repo.list('space-a', {
      query: 'hybrid pagination topic',
      limit: 30,
    });
    const page = await repo.list('space-a', {
      query: 'hybrid pagination topic',
      limit: 10,
      offset: 10,
    });

    expect(page.map((memory) => memory.key)).toEqual(
      fullPage.slice(10, 20).map((memory) => memory.key)
    );
  });
});
