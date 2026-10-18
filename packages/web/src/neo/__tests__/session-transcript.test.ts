import type { ChatMessage } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  type SessionEntry,
  sessionClock,
  sessionDuration,
  sessionEntries,
  sessionEntryBlocks,
  projectSessionTranscript,
  sessionItems,
  sessionStepCounts,
} from '../session-transcript.ts';

const row = (type: string, uuid: string, content: unknown[], at: number) =>
  ({ type, uuid, timestamp: at * 1000, message: { content } }) as unknown as ChatMessage;
const text = (value: string) => ({ type: 'text', text: value });
const tool = (id: string, command: string) => ({
  type: 'tool_use',
  id,
  name: 'Bash',
  input: { command },
});
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

const rows = [
  row('user', 'u1', [text('Run the tests.')], 0),
  row(
    'assistant',
    'a1',
    [
      { type: 'thinking', thinking: 'Which simulator?\nThe booted one.' },
      text('Now build and run the tests:'),
      tool('t1', 'xcodebuild test'),
    ],
    10
  ),
  row('user', 'r1', [result('t1')], 70),
  row('assistant', 'a2', [tool('t2', 'git diff --stat')], 80),
  row('user', 'r2', [result('t2')], 90),
  row('assistant', 'a3', [text('All 84 tests pass.')], 144),
  row('user', 'u2', [text('Thanks!')], 200),
  row('assistant', 'a4', [text('You’re welcome.')], 205),
];

function describeEntries(entries: SessionEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'steps') {
      const { tools } = sessionStepCounts(entry.steps);
      return `steps ${entry.steps.running ? 'running' : 'done'} ${entry.steps.items.length} [${tools}]`;
    }
    const { kind } = entry.item;
    if (kind.type === 'user') return `user ${kind.text}`;
    if (kind.type === 'assistant') return `reply ${kind.text}`;
    if (kind.type === 'tool') return `tool ${kind.summary}`;
    return 'thinking';
  });
}

describe('sessionEntries', () => {
  it('folds each message’s steps into one line and shows a single step as itself', () => {
    const items = sessionItems(rows);
    const entries = sessionEntries(items, false);
    expect(describeEntries(entries)).toEqual([
      'user Run the tests.',
      'thinking',
      'reply Now build and run the tests:',
      'steps done 2 [2]',
      'reply All 84 tests pass.',
      'user Thanks!',
      'reply You’re welcome.',
    ]);
    const steps = entries[3];
    if (steps.type !== 'steps') throw new Error('expected steps');
    expect(sessionDuration(steps.steps.end - steps.steps.start)).toBe('2m 14s');
    expect(steps.steps.items[0].kind).toMatchObject({ result: 'ok', isError: false });
  });

  it('keeps the latest steps a live line while running, even a single one', () => {
    const running = sessionEntries(sessionItems(rows.slice(0, 4)), true);
    expect(describeEntries(running)).toEqual([
      'user Run the tests.',
      'thinking',
      'reply Now build and run the tests:',
      'steps running 2 [2]',
    ]);
    const done = sessionEntries(sessionItems(rows), false)[3];
    expect(done.id).toBe(running[3].id);
    expect(describeEntries(sessionEntries(sessionItems(rows.slice(0, 2)), true)).at(-1)).toBe(
      'steps running 1 [1]'
    );
    expect(describeEntries(sessionEntries(sessionItems(rows.slice(0, 2)), false)).at(-1)).toBe(
      'tool xcodebuild test'
    );
  });

  it('shows a turn without steps as just its messages', () => {
    expect(describeEntries(sessionEntries(sessionItems(rows.slice(-2)), true))).toEqual([
      'user Thanks!',
      'reply You’re welcome.',
    ]);
  });
});

describe('sessionItems', () => {
  it('skips subagent and system rows', () => {
    const items = sessionItems([
      {
        ...row('assistant', 's1', [text('inside')], 1),
        parent_tool_use_id: 't1',
      } as unknown as ChatMessage,
      {
        ...row('user', 's2', [text('delivered')], 2),
        inputKind: 'system',
      } as unknown as ChatMessage,
    ]);
    expect(items).toEqual([]);
  });
});

describe('sessionEntryBlocks', () => {
  it('keeps a message with the steps right after it', () => {
    const blocks = sessionEntryBlocks(sessionEntries(sessionItems(rows), false));
    expect(blocks.map((block) => block.length)).toEqual([1, 1, 2, 1, 1, 1]);
  });
});

describe('sessionDuration and sessionClock', () => {
  it('read naturally', () => {
    expect(sessionDuration(200)).toBe('1s');
    expect(sessionDuration(42_000)).toBe('42s');
    expect(sessionDuration(3_780_000)).toBe('1h 3m');
    expect(sessionClock(42_000)).toBe('0:42');
    expect(sessionClock(725_000)).toBe('12:05');
    expect(sessionClock(3_723_000)).toBe('1:02:03');
  });
});

describe('projectSessionTranscript', () => {
  it('projects rows straight to message blocks', () => {
    const blocks = projectSessionTranscript(rows.slice(0, 4), true);
    expect(blocks.map((block) => block.map((entry) => entry.type))).toEqual([
      ['item'],
      ['item'],
      ['item', 'steps'],
    ]);
  });
});

describe('sessionItems tool results', () => {
  it('marks a call done when its result has no text', () => {
    const items = sessionItems([
      row('assistant', 'a', [tool('t9', 'screenshot')], 1),
      row(
        'user',
        'r',
        [{ type: 'tool_result', tool_use_id: 't9', content: [{ type: 'image' }] }],
        2
      ),
    ]);
    expect(items[0].kind).toMatchObject({ type: 'tool', result: '' });
  });
});

describe('sessionEntries turn-final steps', () => {
  it('ends a turn’s last steps when their results arrived', () => {
    const entries = sessionEntries(
      sessionItems([
        row('user', 'u', [text('Go')], 0),
        row('assistant', 'a', [text('Running both'), tool('p1', 'a'), tool('p2', 'b')], 5),
        row('user', 'r1', [result('p1')], 50),
        row('user', 'r2', [result('p2')], 95),
      ]),
      false
    );
    const steps = entries.at(-1);
    if (steps?.type !== 'steps') throw new Error('expected steps');
    expect(sessionDuration(steps.steps.end - steps.steps.start)).toBe('1m 30s');
  });
});

describe('sessionItems tool headers', () => {
  it('titles invoke calls with their operation and keeps the server for other MCP tools', () => {
    const items = sessionItems([
      row(
        'assistant',
        'a',
        [
          {
            type: 'tool_use',
            id: 'i1',
            name: 'mcp__hyperneo-operations__invoke',
            input: { name: 'daemon.session.inspect', input: {} },
          },
          { type: 'tool_use', id: 'm1', name: 'mcp__filesystem__read_file', input: { path: 'a' } },
        ],
        1
      ),
    ]);
    expect(items.map((item) => item.kind)).toMatchObject([
      { type: 'tool', name: 'invoke daemon.session.inspect', summary: '' },
      { type: 'tool', name: 'read_file', summary: 'filesystem' },
    ]);
  });
});
