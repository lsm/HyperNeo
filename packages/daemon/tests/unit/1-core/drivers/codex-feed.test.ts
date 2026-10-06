import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexFeedSource,
  codexRolloutMeta,
  codexRolloutTurns,
  feedCodexFiles,
} from '../../../../src/lib/drivers/codex-feed';
import {
  changedFeedFiles,
  listFeedFiles,
  pruneVanishedFeeds,
} from '../../../../src/lib/drivers/work-feed';
import { createWorkFeedOffsetsTable } from '../../../../src/storage/schema/m302-work-index-kinds';
import { Database } from '../../../../src/storage/sqlite-compat';
import { readWorkFeedOffsets } from '../../../../src/storage/work-feed';

const meta = (id: string, source: unknown = 'vscode') =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-10-06T05:00:00.000Z',
    payload: { id, cwd: '/Users/me/focus/neokai', source },
  });
const message = (id: string, role: string, texts: string[], at = '2026-10-06T05:01:00.000Z') =>
  JSON.stringify({
    type: 'response_item',
    timestamp: at,
    payload: {
      type: 'message',
      id,
      role,
      content: texts.map((text) => ({
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text,
      })),
    },
  });

describe('codexRolloutMeta and codexRolloutTurns', () => {
  test('reads the thread and keeps only what the user and Codex said', () => {
    expect(codexRolloutMeta(meta('t1'))).toEqual({
      threadId: 't1',
      cwd: '/Users/me/focus/neokai',
      subagent: false,
    });
    expect(codexRolloutMeta(meta('t2', { subagent: { other: 'guardian' } }))?.subagent).toBe(true);
    expect(codexRolloutMeta('{"type":"response_item"}')).toBeNull();
    const turns = codexRolloutTurns(
      [
        message('m0', 'developer', ['system rules']),
        message('m1', 'user', [
          '# AGENTS.md instructions for repo',
          '<environment_context>x</environment_context>',
          'fix the otter bug',
        ]),
        JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
        message('m2', 'assistant', ['Fixed the otter bug.'], '2026-10-06T05:02:00.000Z'),
        'not json',
      ],
      't1'
    );
    expect(turns).toEqual([
      {
        sourceId: 't1:m1',
        messageId: 'm1',
        sessionId: 't1',
        role: 'user',
        text: 'fix the otter bug',
        at: Date.parse('2026-10-06T05:01:00.000Z'),
      },
      {
        sourceId: 't1:m2',
        messageId: 'm2',
        sessionId: 't1',
        role: 'assistant',
        text: 'Fixed the otter bug.',
        at: Date.parse('2026-10-06T05:02:00.000Z'),
      },
    ]);
  });
});

describe('feedCodexFiles', () => {
  let root: string;
  let db: Database;
  const rows = () =>
    db
      .prepare(
        'SELECT kind, session_id AS sessionId, title, body FROM message_search_content ORDER BY id'
      )
      .all();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-feed-'));
    mkdirSync(join(root, '2026', '10', '06'), { recursive: true });
    db = new Database(':memory:');
    db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
      message_id TEXT, session_id TEXT, task_id TEXT, space_id TEXT, task_number INTEGER,
      message_type TEXT, title TEXT, body TEXT, timestamp INTEGER, UNIQUE (kind, source_id))`);
    createWorkFeedOffsetsTable(db);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('indexes top-level threads incrementally and skips subagent rollouts', async () => {
    const thread = join(root, '2026', '10', '06', 'rollout-a-t1.jsonl');
    const guardian = join(root, '2026', '10', '06', 'rollout-b-t2.jsonl');
    writeFileSync(thread, `${meta('t1')}\n${message('m1', 'user', ['fix the otter bug'])}\n`);
    writeFileSync(
      guardian,
      `${meta('t2', { subagent: {} })}\n${message('g1', 'user', ['judge it'])}\n`
    );
    const run = async () =>
      feedCodexFiles(db, changedFeedFiles(listFeedFiles(root, 0), readWorkFeedOffsets(db)));
    expect(await run()).toEqual({ files: 2, turns: 1 });
    expect(await run()).toEqual({ files: 0, turns: 0 });
    appendFileSync(thread, `${message('m2', 'assistant', ['Fixed it.'])}\n{"partial`);
    expect(await run()).toEqual({ files: 1, turns: 1 });
    expect(rows()).toEqual([
      { kind: 'codex', sessionId: 't1', title: 'neokai', body: 'fix the otter bug' },
      { kind: 'codex', sessionId: 't1', title: 'neokai', body: 'Fixed it.' },
    ]);
  });

  test('drops a deleted rollout and its turns on the next pass', async () => {
    const dir = join(root, '2026', '10', '06');
    const keep = join(dir, 'rollout-a-11111111-1111-1111-1111-111111111111.jsonl');
    const gone = join(dir, 'rollout-b-22222222-2222-2222-2222-222222222222.jsonl');
    writeFileSync(
      keep,
      `${meta('11111111-1111-1111-1111-111111111111')}\n${message('k1', 'user', ['keep me'])}\n`
    );
    writeFileSync(
      gone,
      `${meta('22222222-2222-2222-2222-222222222222')}\n${message('g1', 'user', ['forget me'])}\n`
    );
    await feedCodexFiles(db, listFeedFiles(root, 0));
    unlinkSync(gone);
    expect(pruneVanishedFeeds(db, root, codexFeedSource)).toBe(1);
    expect(rows().map((row) => (row as { body: string }).body)).toEqual(['keep me']);
    expect([...readWorkFeedOffsets(db).keys()]).toEqual([keep]);
  });
});
