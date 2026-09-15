import { describe, expect, mock, test } from 'bun:test';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createSendSessionMessageOperation } from '../../../../src/lib/space/operations/session-message-send';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';

type Row = { status: string; processing_state: string | null };

function row(status: string, processingState: string | null = null): Row {
  return { status, processing_state: processingState };
}

function pendingQuestion(toolUseId: string, options: Array<{ label: string }> = []) {
  return JSON.stringify({
    status: 'waiting_for_input',
    pendingQuestion: { toolUseId, questions: [{ options }] },
  });
}

function setup({
  row,
  live,
  sendUserMessage,
}: {
  row: Row | null;
  live: AgentSession | null;
  sendUserMessage?: (data: {
    sessionId: string;
    messageId: string;
    content: string;
  }) => Promise<void>;
}) {
  return createSendSessionMessageOperation({
    getSessionRow: async () => row,
    getLiveSession: async () => live,
    sendUserMessage,
  });
}

describe('session.message.send', () => {
  test('delivers a normal message through sendUserMessage', async () => {
    const sendUserMessage = mock(async () => {});
    const operation = setup({
      row: row('idle'),
      live: null,
      sendUserMessage,
    });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute({ spaceId: 'space-1', sessionId: 'sess-1', message: 'hello' }, { source: 'mcp' });
    expect(result).toMatchObject({
      success: true,
      delivered: true,
      message_id: expect.any(String),
    });
    expect(sendUserMessage).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      messageId: (result as { message_id: string }).message_id,
      content: 'hello',
    });
  });

  test('falls back to startQueryAndEnqueue when sendUserMessage is absent', async () => {
    const live = {
      startQueryAndEnqueue: mock(async () => {}),
      handleQuestionResponse: mock(async () => {}),
    } as unknown as AgentSession;
    const operation = setup({ row: row('idle'), live });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute({ spaceId: 'space-1', sessionId: 'sess-1', message: 'hello' }, { source: 'mcp' });
    expect(result).toMatchObject({
      success: true,
      delivered: true,
      message_id: expect.any(String),
    });
    expect(
      (live as { startQueryAndEnqueue: ReturnType<typeof mock> }).startQueryAndEnqueue
    ).toHaveBeenCalled();
  });

  test('answers a pending question', async () => {
    const live = {
      startQueryAndEnqueue: mock(async () => {}),
      handleQuestionResponse: mock(async () => {}),
    } as unknown as AgentSession;
    const operation = setup({
      row: row('idle', pendingQuestion('tool-1', [{ label: 'yes' }])),
      live,
    });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute(
        { spaceId: 'space-1', sessionId: 'sess-1', message: 'yes', answerQuestion: true },
        { source: 'mcp' }
      );
    expect(result).toMatchObject({ success: true, delivered: true, message_id: 'tool-1' });
    expect(
      (live as { handleQuestionResponse: ReturnType<typeof mock> }).handleQuestionResponse
    ).toHaveBeenCalledWith('tool-1', [
      { questionIndex: 0, selectedLabels: ['yes'], customText: undefined },
    ]);
  });

  test('rejects an answer when the session is not waiting for input', async () => {
    const live = {
      startQueryAndEnqueue: mock(async () => {}),
      handleQuestionResponse: mock(async () => {}),
    } as unknown as AgentSession;
    const operation = setup({ row: row('idle', JSON.stringify({ status: 'idle' })), live });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute(
        { spaceId: 'space-1', sessionId: 'sess-1', message: 'yes', answerQuestion: true },
        { source: 'mcp' }
      );
    expect(result).toMatchObject({ success: false, error: 'Session is not waiting for input' });
    expect(
      (live as { handleQuestionResponse: ReturnType<typeof mock> }).handleQuestionResponse
    ).not.toHaveBeenCalled();
  });

  test('rejects a missing session row', async () => {
    const operation = setup({ row: null, live: null });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute({ spaceId: 'space-1', sessionId: 'sess-1', message: 'hello' }, { source: 'mcp' });
    expect(result).toMatchObject({
      success: false,
      error: 'Session not found in this space: sess-1',
    });
  });

  test('rejects an archived session', async () => {
    const operation = setup({ row: row('archived'), live: null });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute({ spaceId: 'space-1', sessionId: 'sess-1', message: 'hello' }, { source: 'mcp' });
    expect(result).toMatchObject({ success: false, error: 'Session is archived: sess-1' });
  });

  test('rejects when no live session is available and sendUserMessage is absent', async () => {
    const operation = setup({ row: row('idle'), live: null });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute({ spaceId: 'space-1', sessionId: 'sess-1', message: 'hello' }, { source: 'mcp' });
    expect(result).toMatchObject({ success: false, error: 'Live session not available: sess-1' });
  });

  test('validates input through its schema', async () => {
    const { invokeOperation } = await import('../../../../src/lib/operations/invoke');
    const operation = setup({ row: row('idle'), live: null });
    const registry = createOperationRegistry([operation]);
    const outcome = await invokeOperation(
      registry,
      'session.message.send',
      {
        spaceId: 'space-1',
        sessionId: '',
        message: '',
      },
      { source: 'mcp' }
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });

  test('catches execution errors and returns a failure result', async () => {
    const sendUserMessage = mock(async () => {
      throw new Error('send failed');
    });
    const operation = setup({
      row: row('idle'),
      live: null,
      sendUserMessage,
    });
    const registry = createOperationRegistry([operation]);
    const result = await registry
      .get('session.message.send')!
      .execute({ spaceId: 'space-1', sessionId: 'sess-1', message: 'hello' }, { source: 'mcp' });
    expect(result).toMatchObject({ success: false, error: 'send failed' });
  });
});
