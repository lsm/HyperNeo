import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceLongHorizonAgentRepository } from '../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SDKMessageRepository } from '../../../src/storage/repositories/sdk-message-repository';
import { AgentMemoryRepository } from '../../../src/storage/repositories/agent-memory-repository';
import { SpaceAgentMemoryDistillationRepository } from '../../../src/storage/repositories/space-agent-memory-distillation-repository';
import {
  computeBackoffMs,
  DISTILLATION_BACKOFF_BASE_MS,
  DISTILLATION_BACKOFF_MAX_MS,
} from '../../../src/storage/repositories/space-agent-memory-distillation-repository';
import {
  MemoryDistillationService,
  buildTranscript,
  parseDistillationJson,
  resolveDistillationModel,
  DEFAULT_MAX_MESSAGES_PER_PASS,
  DEFAULT_MAX_CHARS_PER_MESSAGE,
  type DistillationContext,
  type DistilledMemory,
  type ExtractMemoriesFn,
} from '../../../src/lib/space/memory-distillation-service';
import { createSpaceTables } from '../helpers/space-test-db';

interface Setup {
  db: Database;
  spaceId: string;
  agentRepo: SpaceLongHorizonAgentRepository;
  messageRepo: SDKMessageRepository;
  memoryRepo: AgentMemoryRepository;
  cursorRepo: SpaceAgentMemoryDistillationRepository;
  spaceRepo: SpaceRepository;
}

function setup(): Setup {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const spaceRepo = new SpaceRepository(db as never);
  const spaceId = spaceRepo.createSpace({
    workspacePath: '/workspace/distillation',
    slug: 'distillation',
    name: 'Distillation',
  }).id;
  return {
    db,
    spaceId,
    spaceRepo,
    agentRepo: new SpaceLongHorizonAgentRepository(db as never),
    messageRepo: new SDKMessageRepository(db as never),
    memoryRepo: new AgentMemoryRepository(db as never),
    cursorRepo: new SpaceAgentMemoryDistillationRepository(db as never),
  };
}

function createAgent(
  s: Setup,
  overrides: Partial<{ handle: string; sessionId: string; status: string }> = {}
) {
  const sessionId = overrides.sessionId ?? `session-${crypto.randomUUID()}`;
  insertSession(s.db, sessionId);
  return s.agentRepo.create({
    spaceId: s.spaceId,
    handle: overrides.handle ?? 'coder',
    displayName: overrides.handle ?? 'Coder',
    status: (overrides.status as 'active') ?? 'active',
    sessionId,
  });
}

function insertSession(db: Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
		 VALUES (?, 'Test', NULL, datetime('now'), datetime('now'), 'active', '{}', '{}')`
  ).run(sessionId);
}

function insertMessage(
  db: Database,
  sessionId: string,
  type: 'user' | 'assistant',
  text: string
): number {
  const message =
    type === 'user'
      ? { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
      : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const result = db
    .prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, is_renderable, is_terminal, parent_tool_use_id)
			 VALUES (?, ?, ?, ?, ?, 'consumed', 1, 0, NULL)`
    )
    .run(crypto.randomUUID(), sessionId, type, JSON.stringify(message), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/** Insert a tool_use-only assistant turn: `is_renderable=1` but no visible text. */
function insertTextlessAssistant(db: Database, sessionId: string): number {
  const message = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu', name: 'bash', input: {} }],
    },
  };
  const result = db
    .prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, is_renderable, is_terminal, parent_tool_use_id)
			 VALUES (?, ?, 'assistant', ?, ?, 'consumed', 1, 0, NULL)`
    )
    .run(crypto.randomUUID(), sessionId, JSON.stringify(message), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/** Mark the current turn complete — establishes the distillation watermark. */
function completeTurn(db: Database, sessionId: string): number {
  const payload = { type: 'result', subtype: 'success', is_error: false, result: 'turn complete' };
  const result = db
    .prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, is_renderable, is_terminal, parent_tool_use_id)
			 VALUES (?, ?, 'result', ?, ?, 'consumed', 0, 1, NULL)`
    )
    .run(crypto.randomUUID(), sessionId, JSON.stringify(payload), new Date().toISOString());
  return Number(result.lastInsertRowid);
}

async function listMemoryKeys(s: Setup): Promise<string[]> {
  const entries = await s.memoryRepo.list(s.spaceId, { limit: 100 });
  return entries.map((entry) => entry.key).sort();
}

describe('MemoryDistillationService', () => {
  let s: Setup;

  beforeEach(() => {
    s = setup();
  });

  it('distills the transcript tail into durable memory and advances the cursor', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'user', 'We are using SQLite for the cache layer.');
    insertMessage(
      s.db,
      agent.sessionId!,
      'assistant',
      'Cached query results in SQLite under packages/daemon/cache.'
    );
    const lastRowid = insertMessage(
      s.db,
      agent.sessionId!,
      'user',
      'Ship it behind the feature flag CACHE_V2.'
    );
    completeTurn(s.db, agent.sessionId!);

    const extractor: ExtractMemoriesFn = async () => [
      {
        key: 'cache-uses-sqlite',
        content: 'The cache layer uses SQLite under packages/daemon/cache.',
        tags: ['cache'],
      },
      {
        key: 'cache-behind-flag',
        content: 'Cache ships behind the CACHE_V2 feature flag.',
        tags: ['flag'],
      },
    ];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: extractor }
    );

    const result = await service.distillAgentById(agent.id);

    expect(result?.distilled).toBe(true);
    expect(result?.messagesRead).toBe(3);
    expect(result?.memoriesWritten).toBe(2);
    expect(result?.cursorRowid).toBe(lastRowid);

    const entries = await s.memoryRepo.list(s.spaceId, { limit: 100 });
    // Keys are namespaced with `distilled:` so they can't collide with curated memory_write keys.
    expect(entries.map((e) => e.key).sort()).toEqual([
      'distilled:cache-behind-flag',
      'distilled:cache-uses-sqlite',
    ]);
    for (const entry of entries) {
      expect(entry.tags).toContain('agent:coder');
      expect(entry.tags).toContain('distilled');
      expect(entry.createdBySession).toBe(agent.sessionId);
    }

    const cursor = s.cursorRepo.getCursor(agent.id);
    expect(cursor?.lastDistilledRowid).toBe(lastRowid);
    expect(cursor?.messagesDistilled).toBe(3);
    expect(cursor?.memoriesWritten).toBe(2);
    expect(cursor?.lastError).toBeNull();
  });

  it('does not reprocess messages the cursor already covered', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'First durable fact.');
    insertMessage(s.db, agent.sessionId!, 'assistant', 'Second durable fact.');
    completeTurn(s.db, agent.sessionId!);

    const calls: string[] = [];
    const extractor: ExtractMemoriesFn = async (transcript) => {
      calls.push(transcript);
      return [{ key: `fact-${calls.length}`, content: transcript.slice(0, 20) }];
    };
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: extractor }
    );

    const first = await service.distillAgentById(agent.id);
    expect(first?.memoriesWritten).toBe(1);
    expect(calls).toHaveLength(1);

    // Second run with no new messages → no extraction call, no new writes.
    const second = await service.distillAgentById(agent.id);
    expect(second?.distilled).toBe(false);
    expect(second?.skipped).toBe('no new messages');
    expect(calls).toHaveLength(1);
    expect(await listMemoryKeys(s)).toEqual(['distilled:fact-1']);
  });

  it('dedupes via key upsert when the same fact is re-distilled', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'The API rate limit is 60 rpm.');
    completeTurn(s.db, agent.sessionId!);

    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => [
          { key: 'api-rate-limit', content: 'The API rate limit is 60 rpm.', tags: ['api'] },
        ],
      }
    );

    await service.distillAgentById(agent.id);

    // Reset the cursor to simulate re-distilling the same content (e.g. a
    // recovered crash). Same namespaced key → upsert, not a duplicate row.
    s.db.prepare(`DELETE FROM space_agent_memory_distillation WHERE agent_id = ?`).run(agent.id);
    await service.distillAgentById(agent.id);

    const entries = await s.memoryRepo.list(s.spaceId, { limit: 100 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('distilled:api-rate-limit');
  });

  it('does not overwrite a curated memory_write key (namespaced keyspace)', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'deployment uses blue-green.');
    completeTurn(s.db, agent.sessionId!);

    // A curated memory the user/agent wrote manually under the shared keyspace.
    s.memoryRepo.write({
      spaceId: s.spaceId,
      key: 'deployment-strategy',
      content: 'Curated: we deploy on Tuesdays only.',
      tags: ['curated'],
    });

    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => [
          {
            key: 'deployment-strategy',
            content: 'Distilled: blue-green deploys.',
            tags: ['deploy'],
          },
        ],
      }
    );
    await service.distillAgentById(agent.id);

    // The curated row is untouched; the distilled fact lands under its own namespaced key.
    const curated = s.memoryRepo.read(s.spaceId, 'deployment-strategy');
    expect(curated?.content).toBe('Curated: we deploy on Tuesdays only.');
    expect(curated?.tags).toContain('curated');
    const distilled = s.memoryRepo.read(s.spaceId, 'distilled:deployment-strategy');
    expect(distilled?.content).toBe('Distilled: blue-green deploys.');
  });

  it('rejects hand-written distilled:-prefixed keys (reserved namespace)', () => {
    // Manual memory_write callers can't create keys under the reserved prefix,
    // so distillation can never clobber a hand-written distilled: key.
    expect(() =>
      s.memoryRepo.write({ spaceId: s.spaceId, key: 'distilled:x', content: 'manual' })
    ).toThrow(/reserved/);
    // A normal key still works, and the automated writer can use the prefix.
    s.memoryRepo.write({ spaceId: s.spaceId, key: 'normal', content: 'ok' });
    s.memoryRepo.write({
      spaceId: s.spaceId,
      key: 'distilled:owned',
      content: 'automated',
      allowReservedNamespace: true,
    });
    expect(s.memoryRepo.read(s.spaceId, 'normal')?.content).toBe('ok');
    expect(s.memoryRepo.read(s.spaceId, 'distilled:owned')?.content).toBe('automated');
  });

  it('bounds each pass to maxMessagesPerPass', async () => {
    const agent = createAgent(s);
    for (let i = 0; i < 10; i++) {
      insertMessage(s.db, agent.sessionId!, 'assistant', `Fact number ${i}.`);
    }
    completeTurn(s.db, agent.sessionId!);

    const transcripts: string[] = [];
    const extractor: ExtractMemoriesFn = async (transcript) => {
      transcripts.push(transcript);
      return [];
    };
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: extractor, maxMessagesPerPass: 4 }
    );

    const result = await service.distillAgentById(agent.id);
    expect(result?.messagesRead).toBe(4);
    // Only the first 4 messages appear in the transcript.
    expect(transcripts[0]).toContain('Fact number 0.');
    expect(transcripts[0]).toContain('Fact number 3.');
    expect(transcripts[0]).not.toContain('Fact number 4.');
  });

  it('advances the cursor past a run of textless (tool-only) rows instead of stalling', async () => {
    const agent = createAgent(s);
    // A block of tool_use-only turns longer than the per-pass limit, followed by
    // a real text turn. Without batch-scan + consumedRowid advance the cursor
    // would stall on the textless block and never reach the text.
    for (let i = 0; i < 40; i++) {
      insertTextlessAssistant(s.db, agent.sessionId!);
    }
    const textRowid = insertMessage(s.db, agent.sessionId!, 'assistant', 'real durable fact');
    completeTurn(s.db, agent.sessionId!);

    const extractor: ExtractMemoriesFn = async () => [
      { key: 'real-fact', content: 'real durable fact' },
    ];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: extractor, maxMessagesPerPass: 10 }
    );

    const result = await service.distillAgentById(agent.id);
    expect(result?.distilled).toBe(true);
    expect(result?.memoriesWritten).toBe(1);
    // Cursor advanced past the entire textless block + the text message.
    expect(result?.cursorRowid).toBeGreaterThanOrEqual(textRowid);
    expect(await listMemoryKeys(s)).toEqual(['distilled:real-fact']);
  });

  it('does not distill an in-flight (not-yet-terminal) turn until it completes', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'mid-flight fact');
    // No completeTurn() yet — the turn is still in progress.

    const extractor: ExtractMemoriesFn = async () => [
      { key: 'mid-flight', content: 'mid-flight fact' },
    ];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: extractor }
    );

    const inFlight = await service.distillAgentById(agent.id);
    expect(inFlight?.distilled).toBe(false);
    expect(inFlight?.skipped).toBe('no new messages');
    expect(await listMemoryKeys(s)).toEqual([]);

    // Turn completes → the watermark rises and the message becomes distillable.
    completeTurn(s.db, agent.sessionId!);
    const completed = await service.distillAgentById(agent.id);
    expect(completed?.distilled).toBe(true);
    expect(await listMemoryKeys(s)).toEqual(['distilled:mid-flight']);
  });

  it('advances the cursor even when the extractor finds nothing durable', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'user', 'hi');
    insertMessage(s.db, agent.sessionId!, 'assistant', 'hello');
    completeTurn(s.db, agent.sessionId!);

    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: async () => [] }
    );

    const result = await service.distillAgentById(agent.id);
    expect(result?.distilled).toBe(true);
    expect(result?.memoriesWritten).toBe(0);
    expect(result?.cursorRowid).toBeGreaterThan(0);

    // Cursor advanced → a re-run sees no new messages.
    const again = await service.distillAgentById(agent.id);
    expect(again?.skipped).toBe('no new messages');
  });

  it('skips inactive agents and agents without a bound session', async () => {
    const active = createAgent(s, { handle: 'active' });
    createAgent(s, { handle: 'paused', status: 'paused' });
    insertMessage(s.db, active.sessionId!, 'assistant', 'active-only fact.');
    completeTurn(s.db, active.sessionId!);

    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: async () => [{ key: 'only-active', content: 'x' }] }
    );

    const result = await service.distillAll();
    expect(result.agentsProcessed).toBe(1); // listActiveWithSessions excludes paused
    expect(result.agentsDistilled).toBe(1);
  });

  it('excludes agents whose Space has been archived', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'fact');
    completeTurn(s.db, agent.sessionId!);

    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: async () => [{ key: 'x', content: 'y' }] }
    );

    // Archiving the Space flips spaces.status but leaves the agent row active.
    s.spaceRepo.archiveSpace(s.spaceId);
    const result = await service.distillAll();
    expect(result.agentsProcessed).toBe(0); // archived Space's agents are excluded
    expect(result.agentsDistilled).toBe(0);
  });

  it('skips agents on a non-SDK (ACP) provider without backoff', async () => {
    const agent = s.agentRepo.create({
      spaceId: s.spaceId,
      handle: 'acp-agent',
      provider: 'acp',
      sessionId: `session-${crypto.randomUUID()}`,
    });
    insertSession(s.db, agent.sessionId!);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'fact');
    completeTurn(s.db, agent.sessionId!);

    const calls: number[] = [];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => {
          calls.push(1);
          return [{ key: 'x', content: 'y' }];
        },
      }
    );

    const result = await service.distillAgentById(agent.id);
    expect(result?.distilled).toBe(false);
    expect(result?.skipped).toContain('unsupported extraction provider: acp');
    expect(calls).toHaveLength(0); // no LLM call

    // No backoff recorded — it would otherwise re-dispatch every cadence forever.
    const cursor = s.cursorRepo.getCursor(agent.id);
    expect(cursor).toBeNull();
  });

  it('skips distillation when the Space is archived between fan-out and run', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'fact');
    completeTurn(s.db, agent.sessionId!);

    const calls: number[] = [];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => {
          calls.push(1);
          return [{ key: 'x', content: 'y' }];
        },
      }
    );

    // Space archived after the coordinator fan-out listed the agent.
    s.spaceRepo.archiveSpace(s.spaceId);
    const result = await service.distillAgentById(agent.id);
    expect(result?.distilled).toBe(false);
    expect(result?.skipped).toBe('space archived');
    expect(calls).toHaveLength(0);
  });

  it('isolates per-agent extraction failures and records them on the cursor', async () => {
    const bad = createAgent(s, { handle: 'bad' });
    const good = createAgent(s, { handle: 'good' });
    insertMessage(s.db, bad.sessionId!, 'assistant', 'will throw');
    insertMessage(s.db, good.sessionId!, 'assistant', 'will succeed');
    completeTurn(s.db, bad.sessionId!);
    completeTurn(s.db, good.sessionId!);

    let n = 0;
    const extractor: ExtractMemoriesFn = async () => {
      n++;
      if (n === 1) throw new Error('provider exploded');
      return [{ key: 'good-fact', content: 'survived' }];
    };
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: extractor }
    );

    const result = await service.distillAll();
    expect(result.agentsProcessed).toBe(2);
    expect(result.agentsDistilled).toBe(1);

    const badCursor = s.cursorRepo.getCursor(bad.id);
    expect(badCursor?.lastError).toContain('provider exploded');
    expect(badCursor?.lastDistilledRowid).toBe(0); // cursor did not advance on failure
    expect(await listMemoryKeys(s)).toEqual(['distilled:good-fact']);
  });

  it('preserves the cursor when a previously-successful agent later fails', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'first durable fact');
    completeTurn(s.db, agent.sessionId!);

    let throwNext = false;
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => {
          if (throwNext) throw new Error('late failure');
          return [{ key: 'first', content: 'first durable fact' }];
        },
      }
    );

    const first = await service.distillAgentById(agent.id);
    expect(first?.distilled).toBe(true);
    const successCursor = s.cursorRepo.getCursor(agent.id)!;
    const successRowid = successCursor.lastDistilledRowid;
    expect(successRowid).toBeGreaterThan(0);
    expect(successCursor.consecutiveFailures).toBe(0);
    expect(successCursor.nextAttemptAt).toBeNull();

    // New message arrives, then extraction fails. The cursor must NOT advance
    // past the new message (so it is retried), and backoff state is recorded.
    insertMessage(s.db, agent.sessionId!, 'assistant', 'second fact, will fail');
    completeTurn(s.db, agent.sessionId!);
    throwNext = true;
    const second = await service.distillAgentById(agent.id);
    expect(second?.distilled).toBe(false);
    expect(second?.skipped).toContain('error');

    const failCursor = s.cursorRepo.getCursor(agent.id)!;
    expect(failCursor.lastDistilledRowid).toBe(successRowid); // preserved — not advanced past the failed batch
    expect(failCursor.consecutiveFailures).toBe(1);
    expect(failCursor.nextAttemptAt).not.toBeNull();
  });

  it('skips extraction during backoff, then resumes once the window elapses', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'will fail first');
    completeTurn(s.db, agent.sessionId!);

    let shouldThrow = true;
    const calls: number[] = [];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => {
          calls.push(calls.length + 1);
          if (shouldThrow) throw new Error('boom');
          return [{ key: 'recovered', content: 'ok' }];
        },
      }
    );

    // First run fails → backoff window scheduled.
    await service.distillAgentById(agent.id);
    const cursor = s.cursorRepo.getCursor(agent.id)!;
    expect(cursor.consecutiveFailures).toBe(1);
    expect(cursor.nextAttemptAt).toBeGreaterThan(Date.now());

    // Immediate re-run is skipped (backoff not elapsed) — no extractor call.
    const skipped = await service.distillAgentById(agent.id);
    expect(skipped?.skipped).toBe('backoff');
    expect(calls).toHaveLength(1);

    // Simulate the backoff window elapsing and the failure clearing.
    s.db
      .prepare(`UPDATE space_agent_memory_distillation SET next_attempt_at = ? WHERE agent_id = ?`)
      .run(Date.now() - 1000, agent.id);
    shouldThrow = false;
    const resumed = await service.distillAgentById(agent.id);
    expect(resumed?.distilled).toBe(true);
    expect(calls).toHaveLength(2);

    const recoveredCursor = s.cursorRepo.getCursor(agent.id)!;
    expect(recoveredCursor.consecutiveFailures).toBe(0);
    expect(recoveredCursor.nextAttemptAt).toBeNull();
  });

  it('respects repo limits when sanitizing extracted memories', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'fact');
    completeTurn(s.db, agent.sessionId!);

    const overlongContent = 'x'.repeat(5000);
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: async () => [{ key: 'big', content: overlongContent }] }
    );

    const result = await service.distillAgentById(agent.id);
    expect(result?.memoriesWritten).toBe(1);
    const entry = s.memoryRepo.read(s.spaceId, 'distilled:big');
    expect(entry?.content.length).toBeLessThanOrEqual(2000);
  });

  it('does not advance the cursor when the extractor returns malformed JSON', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'a durable fact');
    completeTurn(s.db, agent.sessionId!);

    // Mirrors the default extractor: parse the (malformed) model output. A
    // nonempty-but-garbage response must NOT silently advance the cursor.
    const malformedExtractor: ExtractMemoriesFn = async () => parseDistillationJson('not json {');
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: malformedExtractor }
    );

    const result = await service.distillAgentById(agent.id);
    expect(result?.distilled).toBe(false);
    expect(result?.skipped).toContain('error');
    const cursor = s.cursorRepo.getCursor(agent.id)!;
    expect(cursor.lastDistilledRowid).toBe(0); // not advanced → batch will be retried
    expect(cursor.lastError).toContain('malformed');
    expect(await listMemoryKeys(s)).toEqual([]);
  });

  it('skips a paused agent via distillAgentById (TOCTOU recheck)', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'fact');
    completeTurn(s.db, agent.sessionId!);

    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      { extractMemories: async () => [{ key: 'x', content: 'y' }] }
    );

    // Agent is paused AFTER the coordinator fan-out would have listed it.
    s.agentRepo.update(agent.id, { status: 'paused' });
    const result = await service.distillAgentById(agent.id);
    expect(result?.distilled).toBe(false);
    expect(result?.skipped).toContain('not active');
    expect(await listMemoryKeys(s)).toEqual([]);
  });

  it('skips non-blocking when the agent is already in-flight', async () => {
    const agent = createAgent(s);
    insertMessage(s.db, agent.sessionId!, 'assistant', 'fact');
    completeTurn(s.db, agent.sessionId!);

    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: number[] = [];
    const service = new MemoryDistillationService(
      s.agentRepo,
      s.messageRepo,
      s.memoryRepo,
      s.cursorRepo,
      s.spaceRepo,
      {
        extractMemories: async () => {
          calls.push(calls.length + 1);
          await blocked; // hold the first pass open
          return [{ key: 'fact', content: 'fact' }];
        },
      }
    );

    // First pass is in-flight (blocked); a concurrent second pass must skip.
    const first = service.distillAgentById(agent.id);
    const second = await service.distillAgentById(agent.id);
    expect(second?.skipped).toBe('already in-flight');

    release();
    await first;
    expect(calls).toHaveLength(1); // the second pass made no extraction call
  });
});

describe('buildTranscript', () => {
  it('truncates long messages and caps the transcript', () => {
    const long = 'a'.repeat(DEFAULT_MAX_CHARS_PER_MESSAGE + 50);
    const transcript = buildTranscript(
      [
        { role: 'user', text: long },
        { role: 'assistant', text: 'short reply' },
      ],
      {
        maxMessagesPerPass: DEFAULT_MAX_MESSAGES_PER_PASS,
        maxCharsPerMessage: DEFAULT_MAX_CHARS_PER_MESSAGE,
        maxTranscriptChars: 100,
      }
    );
    // Long message was truncated to the per-message cap; overall transcript
    // capped at maxTranscriptChars, keeping the recent tail.
    expect(transcript.length).toBeLessThanOrEqual(100);
    expect(transcript).toContain('short reply');
    expect(transcript).not.toMatch(/^user: a{800}/);
  });
});

describe('parseDistillationJson', () => {
  it('extracts memories from raw model output including code fences', () => {
    const raw = 'Here you go:\n```json\n{"memories":[{"key":"k","content":"c","tags":["t"]}]}\n```';
    const memories = parseDistillationJson(raw);
    expect(memories).toEqual<DistilledMemory[]>([{ key: 'k', content: 'c', tags: ['t'] }]);
  });

  it('throws on malformed output so the pass fails and the batch is retried', () => {
    expect(() => parseDistillationJson('')).toThrow();
    expect(() => parseDistillationJson('no json here')).toThrow();
    expect(() => parseDistillationJson('{"memories":"not-an-array"}')).toThrow();
  });

  it('returns [] only for a legitimately empty memories array', () => {
    expect(parseDistillationJson('{"memories":[]}')).toEqual([]);
  });
});

describe('computeBackoffMs', () => {
  it('doubles from the base each failure and caps at the max', () => {
    expect(computeBackoffMs(1)).toBe(DISTILLATION_BACKOFF_BASE_MS);
    expect(computeBackoffMs(2)).toBe(DISTILLATION_BACKOFF_BASE_MS * 2);
    expect(computeBackoffMs(3)).toBe(DISTILLATION_BACKOFF_BASE_MS * 4);
    expect(computeBackoffMs(50)).toBe(DISTILLATION_BACKOFF_MAX_MS); // capped
  });
});

describe('resolveDistillationModel', () => {
  // These branches resolve without touching the provider service, so they can
  // be asserted directly. The provider-service-dependent branches
  // (provider-only / global fallback) are covered by code review.
  function ctx(overrides: Partial<DistillationContext>): DistillationContext {
    return {
      spaceId: 's',
      agentId: 'a',
      agentHandle: 'h',
      agentDisplayName: 'h',
      sessionId: 'sess',
      agentModel: null,
      agentProvider: null,
      spaceDefaultModel: null,
      ...overrides,
    };
  }

  it('uses the agent model with its pinned provider', async () => {
    const { provider, modelId } = await resolveDistillationModel(
      ctx({ agentModel: 'claude-sonnet-4-6', agentProvider: 'anthropic' })
    );
    expect(provider).toBe('anthropic');
    expect(modelId).toBe('claude-sonnet-4-6');
  });

  it('uses the space default model on its own provider when no agent override', async () => {
    const { provider, modelId } = await resolveDistillationModel(
      ctx({ spaceDefaultModel: 'claude-sonnet-4-6' })
    );
    expect(modelId).toBe('claude-sonnet-4-6');
    // provider is inferred from the model (anthropic family) — not the global default.
    expect(provider).toMatch(/anthropic/i);
  });
});

describe('SDKMessageRepository.getDistillableMessages', () => {
  let db: Database;
  let messageRepo: SDKMessageRepository;
  let sessionId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    sessionId = `session-${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
		 VALUES (?, 'Test', NULL, datetime('now'), datetime('now'), 'active', '{}', '{}')`
    ).run(sessionId);
    messageRepo = new SDKMessageRepository(db as never);
  });

  function insertRaw(
    type: 'user' | 'assistant' | 'system',
    subtype: string | null,
    payload: Record<string, unknown>,
    isTerminal = false
  ): string {
    const id = crypto.randomUUID();
    const sdkUuid = typeof payload.uuid === 'string' ? payload.uuid : null;
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_renderable, is_terminal, parent_tool_use_id, sdk_uuid)
			 VALUES (?, ?, ?, ?, ?, ?, 'consumed', 1, ?, NULL, ?)`
    ).run(
      id,
      sessionId,
      type,
      subtype,
      JSON.stringify(payload),
      new Date().toISOString(),
      isTerminal ? 1 : 0,
      sdkUuid
    );
    return id;
  }

  /** Record a normalized replacement (the durable source the distillation guard reads). */
  function insertReplacement(
    sourceMessageId: string,
    targetUuid: string,
    kind: 'superseded' | 'retracted'
  ): void {
    db.prepare(
      `INSERT INTO sdk_message_replacements (source_message_id, session_id, target_uuid, kind)
			 VALUES (?, ?, ?, ?)`
    ).run(sourceMessageId, sessionId, targetUuid, kind);
  }

  it('excludes retracted and superseded messages', () => {
    insertRaw('assistant', null, {
      type: 'assistant',
      uuid: 'kept',
      message: { role: 'assistant', content: [{ type: 'text', text: 'kept fact' }] },
    });
    insertRaw('assistant', null, {
      type: 'assistant',
      uuid: 'retracted',
      message: { role: 'assistant', content: [{ type: 'text', text: 'retracted fact' }] },
    });
    insertRaw('assistant', null, {
      type: 'assistant',
      uuid: 'superseded',
      message: { role: 'assistant', content: [{ type: 'text', text: 'superseded fact' }] },
    });
    // Marker that retracts the 'retracted' uuid.
    const retractionMarker = insertRaw('system', 'model_refusal_fallback', {
      type: 'system',
      subtype: 'model_refusal_fallback',
      retracted_message_uuids: ['retracted'],
    });
    // Replacement that supersedes the 'superseded' uuid.
    const replacementMsg = insertRaw('assistant', null, {
      type: 'assistant',
      uuid: 'replacement',
      supersedes: ['superseded'],
      message: { role: 'assistant', content: [{ type: 'text', text: 'replacement fact' }] },
    });
    // The distillation guard reads the normalized replacements table.
    insertReplacement(retractionMarker, 'retracted', 'retracted');
    insertReplacement(replacementMsg, 'superseded', 'superseded');
    // Establish a turn-completion watermark covering all rows above.
    insertRaw('system', null, { type: 'result', subtype: 'success', is_error: false }, true);

    const { messages } = messageRepo.getDistillableMessages(sessionId, 0, 50);
    const texts = messages.map((m) => m.text);
    expect(texts).toContain('kept fact');
    expect(texts).toContain('replacement fact'); // the superseding message is still valid
    expect(texts).not.toContain('retracted fact');
    expect(texts).not.toContain('superseded fact');
  });

  it('does not advance the cursor past a deferred/enqueued user message', () => {
    // Assistant text BEFORE a still-enqueued user steering message.
    insertRaw('assistant', null, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'before steer' }] },
    });
    // A user steering message persisted mid-turn as `enqueued` (not yet consumed).
    // Its rowid precedes the assistant row below, but the scan must NOT advance
    // past it: consumption flips send_status in place (same rowid), so a cursor
    // beyond it would permanently skip this user context.
    const steerId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, is_renderable, is_terminal, parent_tool_use_id, sdk_uuid)
			 VALUES (?, ?, 'user', NULL, ?, ?, 'enqueued', 1, 0, NULL, NULL)`
    ).run(
      steerId,
      sessionId,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'please also handle X' }] },
      }),
      new Date().toISOString()
    );
    // Assistant text AFTER the enqueued user — consumed, but sits beyond the
    // mutable-user clamp so it must be excluded until the user flips to consumed.
    insertRaw('assistant', null, {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'after steer' }] },
    });
    // Turn completes — the watermark covers everything, but the clamp still holds.
    insertRaw('system', null, { type: 'result', subtype: 'success', is_error: false }, true);
    const steerRowid = (
      db.prepare(`SELECT rowid FROM sdk_messages WHERE id = ?`).get(steerId) as { rowid: number }
    ).rowid;

    const result = messageRepo.getDistillableMessages(sessionId, 0, 50);
    const texts = result.messages.map((m) => m.text);
    expect(texts).toContain('before steer');
    expect(texts).not.toContain('please also handle X'); // enqueued → excluded
    expect(texts).not.toContain('after steer'); // beyond the mutable-user clamp → excluded
    // Cursor stops before the enqueued user so the later rows remain distillable
    // once the user is consumed.
    expect(result.consumedRowid).toBeLessThan(steerRowid);

    // Once the steering message is consumed in place (same rowid), the clamp
    // lifts and the remaining rows become distillable from the advanced cursor.
    db.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(steerId);
    const result2 = messageRepo.getDistillableMessages(sessionId, result.consumedRowid, 50);
    const texts2 = result2.messages.map((m) => m.text);
    expect(texts2).toContain('please also handle X');
    expect(texts2).toContain('after steer');
  });
});

describe('SpaceAgentMemoryDistillationRepository.clampCursorToRemainingMessages', () => {
  let db: Database;
  let cursorRepo: SpaceAgentMemoryDistillationRepository;
  let sessionId: string;
  let agentId: string;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as never);
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/clamp',
      slug: 'clamp',
      name: 'Clamp',
    }).id;
    sessionId = `session-${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
		 VALUES (?, 'Test', NULL, datetime('now'), datetime('now'), 'active', '{}', '{}')`
    ).run(sessionId);
    const agentRepo = new SpaceLongHorizonAgentRepository(db as never);
    agentId = agentRepo.create({ spaceId, handle: 'clamp-agent', sessionId }).id;
    cursorRepo = new SpaceAgentMemoryDistillationRepository(db as never);
  });

  function seedMessage(text: string): number {
    const message = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    };
    const result = db
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, is_renderable, is_terminal, parent_tool_use_id)
			 VALUES (?, ?, 'assistant', ?, ?, 'consumed', 1, 0, NULL)`
      )
      .run(crypto.randomUUID(), sessionId, JSON.stringify(message), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  it('clamps the cursor down to the max remaining rowid after a rewind deletes the tail', () => {
    // Distillation had advanced to rowid 10, then a rewind deleted the tail
    // (rows 6-10), leaving 1-5.
    seedMessage('m1'); // rowid 1
    seedMessage('m2'); // 2
    seedMessage('m3'); // 3
    seedMessage('m4'); // 4
    seedMessage('m5'); // 5
    cursorRepo.recordSuccess(agentId, {
      spaceId,
      sessionId,
      lastDistilledRowid: 10,
      messagesDistilled: 10,
      memoriesWritten: 1,
    });
    expect(cursorRepo.getCursor(agentId)!.lastDistilledRowid).toBe(10);

    // After rewind, remaining max rowid is 5 → cursor must clamp from 10 to 5.
    const changed = cursorRepo.clampCursorToRemainingMessages(sessionId);
    expect(changed).toBe(1);
    const cursor = cursorRepo.getCursor(agentId)!;
    expect(cursor.lastDistilledRowid).toBe(5);

    // A new message lands at rowid 6 (>5) → still distilled, not skipped.
    const newRowid = seedMessage('m6-after-rewind');
    expect(newRowid).toBe(6);
    expect(newRowid).toBeGreaterThan(cursor.lastDistilledRowid);
  });

  it('is a no-op for sessions with no distillation cursor', () => {
    seedMessage('m1');
    expect(cursorRepo.clampCursorToRemainingMessages(sessionId)).toBe(0);
  });
});
