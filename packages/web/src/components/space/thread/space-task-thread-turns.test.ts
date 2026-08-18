import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { buildAgentTurns, isUserRow } from './space-task-thread-turns';
import type { ParsedThreadRow } from './space-task-thread-events';

function makeAssistantTextMessage(uuid: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}

function makeResultMessage(uuid: string, subtype: 'success' | 'error' = 'success'): SDKMessage {
  return {
    type: 'result',
    subtype,
    uuid,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as SDKMessage;
}

function makeUserMessage(uuid: string, text: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { content: text },
  } as unknown as SDKMessage;
}

function makeUserReplayMessage(uuid: string, text: string): SDKMessage {
  return {
    type: 'user',
    isReplay: true,
    uuid,
    message: { content: text },
  } as unknown as SDKMessage;
}

function makeRow(
  id: string,
  label: string,
  message: SDKMessage | null = makeAssistantTextMessage(id, 'hello')
): ParsedThreadRow {
  return {
    id,
    sessionId: null,
    label,
    taskId: 'task-1',
    taskTitle: 'Task One',
    createdAt: Date.now(),
    message,
    fallbackText: null,
  } as unknown as ParsedThreadRow;
}

function makeResultRow(
  id: string,
  label: string,
  subtype: 'success' | 'error' = 'success'
): ParsedThreadRow {
  return makeRow(id, label, makeResultMessage(id, subtype));
}

describe('buildAgentTurns', () => {
  it('returns empty array for no rows', () => {
    expect(buildAgentTurns([])).toEqual([]);
  });

  it('groups consecutive rows from the same agent into one block', () => {
    const rows = [
      makeRow('1', 'Task Agent'),
      makeRow('2', 'Task Agent'),
      makeRow('3', 'Task Agent'),
    ];
    const blocks = buildAgentTurns(rows);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].agentLabel).toBe('Task Agent');
    expect(blocks[0].rows).toHaveLength(3);
  });

  it('starts a new block when the agent label changes', () => {
    const rows = [
      makeRow('1', 'Task Agent'),
      makeRow('2', 'Coder Agent'),
      makeRow('3', 'Reviewer Agent'),
    ];
    const blocks = buildAgentTurns(rows);
    expect(blocks.map((b) => b.agentLabel)).toEqual([
      'Task Agent',
      'Coder Agent',
      'Reviewer Agent',
    ]);
  });

  it('marks a block terminal when it ends with a result message', () => {
    const rows = [makeRow('1', 'Task Agent'), makeResultRow('2', 'Task Agent')];
    const blocks = buildAgentTurns(rows);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isTerminal).toBe(true);
  });

  it('splits the same agent into separate blocks across exec cycles', () => {
    const rows = [
      makeRow('a1', 'Reviewer Agent'),
      makeResultRow('r1', 'Reviewer Agent'),
      makeRow('a2', 'Reviewer Agent'),
      makeResultRow('r2', 'Reviewer Agent'),
      makeRow('a3', 'Reviewer Agent'),
      makeResultRow('r3', 'Reviewer Agent'),
    ];
    const blocks = buildAgentTurns(rows);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block.agentLabel).toBe('Reviewer Agent');
      expect(block.isTerminal).toBe(true);
      expect(block.rows).toHaveLength(2);
    }
  });

  it('keeps the result row at the tail of its turn', () => {
    const rows = [
      makeRow('a1', 'Task Agent'),
      makeRow('a2', 'Task Agent'),
      makeResultRow('r1', 'Task Agent'),
    ];
    const blocks = buildAgentTurns(rows);
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block.rows).toHaveLength(3);
    expect(block.rows[2].id).toBe('r1');
    expect(block.isTerminal).toBe(true);
  });

  it('treats agent label whitespace and casing as equivalent', () => {
    const rows = [makeRow('1', 'Task Agent'), makeRow('2', 'task   agent')];
    const blocks = buildAgentTurns(rows);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rows).toHaveLength(2);
  });
});

describe('isUserRow', () => {
  it('returns true for a user message', () => {
    const row = makeRow('1', 'human', makeUserMessage('1', 'hi'));
    expect(isUserRow(row)).toBe(true);
  });

  it('returns true for a synthetic agent→agent handoff (user_replay)', () => {
    const row = makeRow('1', 'Coder Agent', makeUserReplayMessage('1', 'investigate'));
    expect(isUserRow(row)).toBe(true);
  });

  it('returns false for an assistant message', () => {
    const row = makeRow('1', 'Task Agent');
    expect(isUserRow(row)).toBe(false);
  });

  it('returns false for a result message', () => {
    const row = makeResultRow('1', 'Task Agent');
    expect(isUserRow(row)).toBe(false);
  });

  it('returns false when the row has no message', () => {
    const row = makeRow('1', 'Task Agent', null);
    expect(isUserRow(row)).toBe(false);
  });
});
