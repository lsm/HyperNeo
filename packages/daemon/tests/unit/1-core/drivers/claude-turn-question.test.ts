import { describe, expect, test } from 'bun:test';
import { claudeTurnQuestion } from '../../../../src/lib/drivers/claude-turn-question.ts';
import {
  claudeTranscriptState,
  describeClaudeSession,
} from '../../../../src/lib/drivers/claude-desktop-adapter.ts';

const row = (entry: object) => JSON.stringify(entry);
const wrapUp = (input: object) =>
  row({
    type: 'assistant',
    message: {
      id: 'wrap',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input }],
    },
  });
const ended = (id = 'closing') =>
  row({
    type: 'assistant',
    message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Closing message.' }] },
  });
const toolResult = row({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
});
const human = row({ type: 'user', message: { content: 'Yes, do it' } });
const wake = row({ type: 'user', isMeta: true, message: { content: 'hidden wake' } });
const peer = row({
  type: 'attachment',
  attachment: { type: 'queued_command', origin: { kind: 'peer', body: 'From Neo' } },
});
const asking = {
  recap: 'Fixed it.',
  ask: 'Ship it?',
  actions: [{ label: 'Yes, ship' }, { action: 'commit' }, { label: 'Not now' }],
};

describe('claudeTurnQuestion', () => {
  test('returns the question and button labels when the turn ended on it', () => {
    expect(claudeTurnQuestion([human, wrapUp(asking), toolResult, ended()])).toEqual({
      text: 'Ship it?',
      actions: ['Yes, ship', 'commit', 'Not now'],
    });
  });

  test('uses the recap when the worker is blocked without a question', () => {
    expect(
      claudeTurnQuestion([wrapUp({ recap: 'Waiting on a key.', blocked: true }), ended()])
    ).toEqual({ text: 'Waiting on a key.', actions: [] });
  });

  test.each([
    ['a human reply came after', [wrapUp(asking), toolResult, ended(), human]],
    ['a peer input came after', [wrapUp(asking), toolResult, ended(), peer]],
    ['a later turn ended without asking', [wrapUp(asking), ended(), wake, ended('later')]],
    ['the turn is still going', [wrapUp(asking), toolResult]],
    ['the last wrap-up asked nothing', [wrapUp(asking), wrapUp({ recap: 'Done.' }), ended()]],
    ['the turn only ended', [human, ended()]],
    [
      'the question came from a subagent',
      [
        row({ ...JSON.parse(wrapUp(asking)), isSidechain: true }),
        row({ ...JSON.parse(ended()), isSidechain: true }),
      ],
    ],
  ])('finds nothing when %s', (_label, lines) => {
    expect(claudeTurnQuestion(lines)).toBeNull();
  });
});

describe('describeClaudeSession with a turn-ended question', () => {
  const record = {
    sessionId: 'desktop',
    cliSessionId: 'session',
    title: 'fixture',
    isArchived: false,
    lastActivityAt: 0,
  };
  const transcript = claudeTranscriptState([wrapUp(asking), toolResult, ended()]);
  const live = (status: string) => [{ sessionId: 'session', status }];

  test('an idle session that asked needs someone, with the question as waitingFor', () => {
    expect(describeClaudeSession(record, live('idle'), transcript, { machine: 'm' })).toMatchObject(
      {
        ok: true,
        value: {
          status: 'needs_you',
          waitingFor: 'Ship it?',
          turnQuestion: { text: 'Ship it?', actions: ['Yes, ship', 'commit', 'Not now'] },
        },
      }
    );
  });

  test('a long question fits waitingFor and stays whole on turnQuestion', () => {
    const text = 'x'.repeat(250);
    const state = claudeTranscriptState([wrapUp({ ask: text }), ended()]);
    const detail = describeClaudeSession(record, [], state, { machine: 'm' });
    if (!detail.ok) throw new Error('Expected status');
    expect(detail.value.waitingFor).toHaveLength(200);
    expect(detail.value.turnQuestion?.text).toBe(text);
  });

  test.each([
    ['running again', live('busy'), record, 'running' as const],
    ['archived', [], { ...record, isArchived: true }, 'stopped' as const],
  ])('keeps its status while %s', (_label, sessions, target, status) => {
    const detail = describeClaudeSession(target, sessions, transcript, { machine: 'm' });
    if (!detail.ok) throw new Error('Expected status');
    expect(detail.value.status).toBe(status);
    expect(detail.value.turnQuestion).toBeUndefined();
  });

  test('a real waiting prompt stays a real prompt', () => {
    const detail = describeClaudeSession(
      record,
      [{ sessionId: 'session', status: 'waiting', waitingFor: 'permission prompt' }],
      transcript,
      { machine: 'm' }
    );
    if (!detail.ok) throw new Error('Expected status');
    expect(detail.value.waitingFor).toBe('permission prompt');
    expect(detail.value.turnQuestion).toBeUndefined();
  });
});
