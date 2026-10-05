import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readNeoCatchUp, renderNeoCatchUp } from '../../../../src/lib/neo/catch-up.ts';
import { restrictNeoQuery } from '../../../../src/lib/neo/session-policy.ts';
import {
  type NeoRouteEntry,
  NeoRoutingLogRepository,
} from '../../../../src/storage/repositories/neo-routing-log-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const at = Date.parse('2026-10-05T18:20:00Z');
const entry = (n: number, fields: Partial<NeoRouteEntry> = {}): NeoRouteEntry => ({
  messageId: `m${n}`,
  conversationId: 'c',
  askedAt: at + n * 60_000,
  ask: `ask ${n}`,
  destination: 'holder',
  targetSessionId: 'neo:holder:drivers',
  concernId: 'drivers',
  signal: 'embedding',
  confidence: 0.9,
  ...fields,
});

describe('readNeoCatchUp', () => {
  let db: Database;
  let log: NeoRoutingLogRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    createNeoTables(db);
    db.exec(`INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at)
      VALUES ('drivers', 'Neo driver epic', '', '', 1, 0, 0)`);
    log = new NeoRoutingLogRepository(db);
  });
  afterEach(() => db.close());

  test('is empty when nothing went around main Neo', () => {
    log.record(entry(1, { destination: 'main', concernId: null }));
    expect(readNeoCatchUp(db)).toBe('');
  });

  test('lists what holders handled since main Neo last had a message', () => {
    log.record(entry(1, { destination: 'main', concernId: null, ask: 'before' }));
    log.record(entry(2, { ask: 'old holder ask' }));
    log.record(entry(3, { destination: 'main', concernId: null }));
    log.record(entry(4, { ask: 'restart the iMac daemon?' }));
    log.recordOutcome('m4', 'Pull dev and restart it.', at);
    log.record(entry(5, { destination: 'new', concernId: null, ask: 'cloudflare post' }));
    log.record(entry(6, { destination: 'main', concernId: null, ask: 'now' }));
    const text = readNeoCatchUp(db);
    expect(text).toContain(
      '18:24 UTC, Neo driver epic: "restart the iMac daemon?" → Pull dev and restart it.'
    );
    expect(text).toContain('18:25 UTC, a new topic: "cloudflare post" → (no reply yet)');
    expect(text).not.toContain('old holder ask');
    expect(text).not.toContain('"now"');
  });
});

describe('renderNeoCatchUp', () => {
  test('collapses older routes per topic and stays bounded', () => {
    const routes = Array.from({ length: 30 }, (_, n) => ({
      ...entry(n, { concernId: n < 20 ? 'drivers' : 'youtube', ask: 'x'.repeat(300) }),
      id: n + 1,
      outcome: null,
      outcomeAt: null,
    }));
    const text = renderNeoCatchUp(routes, new Map([['drivers', 'Neo driver epic']]));
    expect(text).toContain('- 18 earlier: Neo driver epic ×18');
    expect(text.length).toBeLessThanOrEqual(3_001);
  });
});

describe('restrictNeoQuery', () => {
  test('appends the catch-up only when there is one', () => {
    const plain: Options = {};
    restrictNeoQuery(plain, null);
    const caught: Options = {};
    restrictNeoQuery(caught, null, undefined, 'Catch-up: one thing happened');
    const prompt = (options: Options) => (options.systemPrompt as { prompt: string }).prompt;
    expect(prompt(caught)).toBe(`${prompt(plain)}\n\nCatch-up: one thing happened`);
  });
});
