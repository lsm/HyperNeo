import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexTurnFacts } from '../../../../src/lib/drivers/codex-turn-reader';

const at = (second: number) => `2026-11-06T04:00:${String(second).padStart(2, '0')}.000Z`;
const ms = (second: number) => Date.parse(at(second));
const event = (second: number, payload: object) =>
  JSON.stringify({ timestamp: at(second), type: 'event_msg', payload });
const item = (second: number, payload: object) =>
  JSON.stringify({ timestamp: at(second), type: 'response_item', payload });
const started = (second: number, turn: string) =>
  event(second, { type: 'task_started', turn_id: turn });
const completed = (second: number, turn: string, text = 'done', extra = {}) =>
  event(second, { type: 'task_complete', turn_id: turn, last_agent_message: text, ...extra });
const said = (second: number, id: string, text: string) =>
  item(second, {
    type: 'message',
    id,
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
const ran = (second: number, output: unknown) =>
  item(second, { type: 'function_call_output', call_id: 'c', output });

let dir: string;
let path: string;
const write = (...lines: string[]) => writeFileSync(path, `${lines.join('\n')}\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-turns-'));
  path = join(dir, 'rollout.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readCodexTurnFacts', () => {
  test('reads a turn from real log shapes', async () => {
    write(
      JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: 'thread' } }),
      started(1, 'turn-1'),
      said(2, 'input-1', 'open a PR'),
      said(2, 'env', '<environment_context>x</environment_context>'),
      ran(3, 'https://github.com/o/r/pull/1\n'),
      item(4, {
        type: 'custom_tool_call_output',
        output: [{ type: 'input_text', text: 'see https://example.com/a.' }],
      }),
      completed(5, 'turn-1', 'Opened https://github.com/o/r/pull/2')
    );
    expect(await readCodexTurnFacts(path)).toEqual([
      {
        id: 'turn-1',
        startedAt: ms(1),
        endedAt: ms(5),
        ended: 'completed',
        inputs: ['input-1'],
        urls: [
          'https://github.com/o/r/pull/1',
          'https://example.com/a',
          'https://github.com/o/r/pull/2',
        ],
        finalUrls: ['https://github.com/o/r/pull/2'],
        complete: true,
        cursor: expect.any(String),
      },
    ]);
  });

  test('a mention in a user message or the compaction history is not output', async () => {
    write(
      started(1, 'turn-1'),
      said(2, 'input-1', 'look at https://github.com/o/r/pull/9'),
      JSON.stringify({
        timestamp: at(3),
        type: 'compacted',
        payload: { message: 'https://github.com/o/r/pull/8' },
      }),
      completed(4, 'turn-1')
    );
    expect((await readCodexTurnFacts(path))[0].urls).toEqual([]);
  });

  test('reports aborted and errored turns, and a turn with no input of its own', async () => {
    write(
      started(1, 'turn-1'),
      ran(2, 'https://github.com/o/r/pull/1'),
      event(3, { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' }),
      started(4, 'turn-2'),
      said(5, 'env', '<environment_context>x</environment_context>'),
      completed(6, 'turn-2', '', { error: { message: 'failed' } })
    );
    expect(await readCodexTurnFacts(path)).toMatchObject([
      { id: 'turn-1', ended: 'aborted', urls: ['https://github.com/o/r/pull/1'], complete: true },
      { id: 'turn-2', ended: 'errored', inputs: [], complete: true },
    ]);
  });

  test('a steered message stays in the running turn', async () => {
    write(
      started(1, 'turn-1'),
      said(2, 'a', 'first'),
      said(3, 'b', 'steer'),
      completed(4, 'turn-1')
    );
    expect((await readCodexTurnFacts(path))[0].inputs).toEqual(['a', 'b']);
  });

  test('a running turn is not reported until it ends', async () => {
    write(started(1, 'turn-1'), ran(2, 'https://github.com/o/r/pull/1'));
    expect(await readCodexTurnFacts(path)).toEqual([]);
    appendFileSync(path, `${completed(3, 'turn-1')}\n`);
    expect(await readCodexTurnFacts(path)).toMatchObject([
      { urls: ['https://github.com/o/r/pull/1'] },
    ]);
  });

  test('a line still being written is left for the next read', async () => {
    write(started(1, 'turn-1'));
    appendFileSync(path, completed(2, 'turn-1').slice(0, 20));
    expect(await readCodexTurnFacts(path)).toEqual([]);
  });

  test('a turn that never ended is marked incomplete when the next one starts', async () => {
    write(started(1, 'turn-1'), ran(2, 'x'), started(5, 'turn-2'), completed(6, 'turn-2'));
    const [lost, next] = await readCodexTurnFacts(path);
    expect(lost).toMatchObject({ id: 'turn-1', ended: 'unknown', endedAt: ms(2), complete: false });
    expect(next).toMatchObject({ id: 'turn-2', ended: 'completed', complete: true });
    const again = await readCodexTurnFacts(path, lost.cursor);
    expect(again.map((turn) => turn.id)).toEqual(['turn-2']);
  });

  test('an unreadable line inside a turn makes the turn incomplete', async () => {
    write(started(1, 'turn-1'), '{broken', completed(2, 'turn-1'));
    expect((await readCodexTurnFacts(path))[0]).toMatchObject({ complete: false });
  });

  test('continues from the cursor past a turn bigger than the old 4 MB tail', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    write(
      started(1, 'turn-1'),
      ran(2, 'https://github.com/o/r/pull/1'),
      ran(3, big),
      completed(4, 'turn-1'),
      started(5, 'turn-2'),
      completed(6, 'turn-2', 'é https://github.com/o/r/pull/2')
    );
    const all = await readCodexTurnFacts(path);
    expect(all[0].urls).toContain('https://github.com/o/r/pull/1');
    const rest = await readCodexTurnFacts(path, all[0].cursor);
    expect(rest).toEqual([all[1]]);
    expect(await readCodexTurnFacts(path, all[1].cursor)).toEqual([]);
  });

  test('reads a few turns at a time and resumes where it stopped', async () => {
    const turns = Array.from({ length: 13 }, (_, index) => [
      started(index, `turn-${index}`),
      completed(index, `turn-${index}`),
    ]);
    write(...turns.flat());
    const first = await readCodexTurnFacts(path);
    expect(first).toHaveLength(10);
    const rest = await readCodexTurnFacts(path, first.at(-1)?.cursor);
    expect(rest.map((turn) => turn.id)).toEqual(['turn-10', 'turn-11', 'turn-12']);
  });
});
