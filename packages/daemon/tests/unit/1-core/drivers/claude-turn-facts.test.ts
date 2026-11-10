import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeTurnFacts } from '../../../../src/lib/drivers/claude-turn-facts.ts';

const at = (second: number) => `2026-11-04T10:00:${String(second).padStart(2, '0')}.000Z`;
const human = (uuid: string, second: number, text: string) => ({
  type: 'user',
  uuid,
  timestamp: at(second),
  message: { content: text },
});
const tool = (second: number, text: string) => ({
  type: 'user',
  uuid: `tool-${second}`,
  timestamp: at(second),
  message: { content: [{ type: 'tool_result', content: text }] },
});
const reply = (uuid: string, second: number, text: string, stop = 'end_turn') => ({
  type: 'assistant',
  uuid,
  timestamp: at(second),
  message: { stop_reason: stop, content: [{ type: 'text', text }] },
});
const PR = 'https://github.com/lsm/HyperNeo/pull/1';

describe('readClaudeTurnFacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-turns-'));
  const file = (rows: readonly unknown[], name = 'session.jsonl') => {
    const path = join(dir, name);
    writeFileSync(
      path,
      rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n'
    );
    return path;
  };

  test('a finished turn reports its input, time, end and the URLs in tool output and the final message', async () => {
    const [turn] = await readClaudeTurnFacts(
      file([
        human('in-1', 1, 'Open it'),
        reply('mid', 2, `Mentioned ${PR}/ignored`, 'tool_use'),
        tool(3, `${PR}\n`),
        reply('end-1', 4, 'Done https://example.com/report.'),
      ])
    );
    expect(turn).toMatchObject({
      id: 'end-1',
      startedAt: Date.parse(at(1)),
      endedAt: Date.parse(at(4)),
      ended: 'end_turn',
      inputs: ['in-1'],
      complete: true,
    });
    expect(turn.urls.toSorted()).toEqual(['https://example.com/report', PR]);
    expect(turn.finalUrls).toEqual(['https://example.com/report']);
  });

  test('a message queued during a turn is an input of that turn, by the id its receipt holds', async () => {
    const [turn] = await readClaudeTurnFacts(
      file([
        human('in-1', 1, 'First'),
        {
          type: 'attachment',
          uuid: 'row-id',
          timestamp: at(2),
          attachment: {
            type: 'queued_command',
            source_uuid: 'receipt-id',
            origin: { kind: 'peer', body: 'Second' },
          },
        },
        reply('end-1', 3, 'Both'),
      ])
    );
    expect(turn.inputs).toEqual(['in-1', 'receipt-id']);
  });

  test('a message absorbed into the running turn is an input by its command id', async () => {
    const [turn] = await readClaudeTurnFacts(
      file([
        human('in-1', 1, 'First'),
        {
          type: 'queue-operation',
          operation: 'remove',
          reason: 'absorbed_mid_turn',
          commandUuid: 'absorbed-id',
          timestamp: at(2),
        },
        reply('end-1', 3, 'Both'),
      ])
    );
    expect(turn.inputs).toEqual(['in-1', 'absorbed-id']);
  });

  test('a relayed Desktop message also carries the id its pending receipt can match', async () => {
    const body = 'Relayed work';
    const text = `<cross-session-message from="helper" from-name="Neo">\n${body}\n</cross-session-message>`;
    const [turn] = await readClaudeTurnFacts(
      file([human('in-1', 1, text), reply('end-1', 2, 'Done')])
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(['helper', body]))
      .digest('hex');
    expect(turn.inputs).toEqual(['in-1', `desktop-pending:${hash}`]);
  });

  test('an interrupt ends the turn and is not an input of the next one', async () => {
    const stopped = {
      type: 'user',
      uuid: 'stop',
      timestamp: at(3),
      message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    };
    const turns = await readClaudeTurnFacts(
      file([
        human('in-1', 1, 'First'),
        tool(2, PR),
        stopped,
        human('in-2', 4, 'Second'),
        reply('end-2', 5, 'Done'),
      ])
    );
    expect(turns.map((turn) => [turn.id, turn.ended, turn.inputs, turn.urls])).toEqual([
      ['stop', 'interrupted', ['in-1'], [PR]],
      ['end-2', 'end_turn', ['in-2'], []],
    ]);
  });

  test('a compaction summary is not an input and does not split the turn', async () => {
    const turns = await readClaudeTurnFacts(
      file([
        human('in-1', 1, 'Long work'),
        { type: 'system', subtype: 'compact_boundary', timestamp: at(2) },
        { ...human('summary', 3, 'Summary of the conversation'), isCompactSummary: true },
        tool(4, PR),
        reply('end-1', 5, 'Done'),
      ])
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ inputs: ['in-1'], urls: [PR] });
  });

  test('an unfinished turn waits, and the cursor picks up after the last finished one', async () => {
    const rows = [human('in-1', 1, 'One'), reply('end-1', 2, 'Done'), human('in-2', 3, 'Two')];
    const first = await readClaudeTurnFacts(file(rows));
    expect(first.map((turn) => turn.id)).toEqual(['end-1']);
    const path = file([...rows, reply('end-2', 4, 'Finished')]);
    const next = await readClaudeTurnFacts(path, first[0].cursor);
    expect(next.map((turn) => [turn.id, turn.inputs])).toEqual([['end-2', ['in-2']]]);
    expect(await readClaudeTurnFacts(path, next[0].cursor)).toEqual([]);
  });

  test('a final message split over several rows is one turn ending at its last row', async () => {
    const part = (uuid: string, second: number, text: string) => {
      const row = reply(uuid, second, text);
      return { ...row, message: { ...row.message, id: 'message-1' } };
    };
    const turns = await readClaudeTurnFacts(
      file([human('in-1', 1, 'Work'), part('a', 2, 'First part'), part('b', 3, `Opened ${PR}`)])
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: 'b', inputs: ['in-1'], urls: [PR] });
  });

  test('a URL in Markdown is read without its backticks or bold markers', async () => {
    const [turn] = await readClaudeTurnFacts(
      file([human('in-1', 1, 'Work'), reply('end-1', 2, `Opened \`${PR}\` and **${PR}/2**`)])
    );
    expect(turn.urls).toEqual([PR, `${PR}/2`]);
  });

  test('a subagent row and a meta row are neither input nor output', async () => {
    const [turn] = await readClaudeTurnFacts(
      file([
        human('in-1', 1, 'Work'),
        { ...tool(2, PR), isSidechain: true },
        { ...human('meta', 3, 'Caveat'), isMeta: true },
        reply('end-1', 4, 'Done'),
      ])
    );
    expect(turn).toMatchObject({ inputs: ['in-1'], urls: [] });
  });

  test('a row that cannot be read marks the turn incomplete', async () => {
    const [turn] = await readClaudeTurnFacts(
      file([human('in-1', 1, 'Work'), '{not json', reply('end-1', 2, 'Done')])
    );
    expect(turn.complete).toBe(false);
  });

  test('a row that cannot be read after a turn ended leaves that turn complete', async () => {
    const turns = await readClaudeTurnFacts(
      file([human('in-1', 1, 'Work'), reply('end-1', 2, 'Done'), '{torn'])
    );
    expect(turns.map((turn) => [turn.id, turn.complete])).toEqual([['end-1', true]]);
  });

  test('finished replies without a message id stay separate turns', async () => {
    const turns = await readClaudeTurnFacts(
      file([reply('end-1', 1, 'One'), reply('end-2', 2, 'Two')])
    );
    expect(turns.map((turn) => turn.id)).toEqual(['end-1', 'end-2']);
  });

  test('an end row with no time does not end the turn', async () => {
    const { timestamp: _none, ...untimed } = reply('no-time', 2, 'Part');
    const turns = await readClaudeTurnFacts(
      file([human('in-1', 1, 'Work'), untimed, reply('end-1', 3, 'Done')])
    );
    expect(turns.map((turn) => turn.id)).toEqual(['end-1']);
  });

  test('a turn with no input starts at its first timed row', async () => {
    const [turn] = await readClaudeTurnFacts(file([tool(1, PR), reply('end-1', 2, 'Done')]));
    expect(turn).toMatchObject({ inputs: [], startedAt: Date.parse(at(1)) });
  });

  test('a read stops after ten turns and the next read continues', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => [
      human(`in-${index}`, index, 'Next'),
      reply(`end-${index}`, index, 'Done'),
    ]).flat();
    const path = file(rows);
    const first = await readClaudeTurnFacts(path);
    expect(first).toHaveLength(10);
    expect((await readClaudeTurnFacts(path, first[9].cursor)).map((turn) => turn.id)).toEqual([
      'end-10',
      'end-11',
    ]);
  });

  test('a missing transcript has no turns', async () => {
    expect(await readClaudeTurnFacts(join(dir, 'gone.jsonl'))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
