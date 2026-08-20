import { describe, expect, test, beforeEach } from 'bun:test';
import { AcpMessageTranslator } from '../../../../src/lib/acp/acp-message-translator';
import type {
  AcpAgentMessageChunkUpdate,
  AcpAgentThoughtChunkUpdate,
  AcpToolCallUpdateNotification,
  AcpToolCallUpdateUpdate,
} from '@hyperneo/shared';

describe('AcpMessageTranslator', () => {
  let translator: AcpMessageTranslator;

  beforeEach(() => {
    translator = new AcpMessageTranslator('test-session');
  });

  test('accumulates text chunks and emits on flush', () => {
    translator.processUpdate(agentChunk('Hello'));
    translator.processUpdate(agentChunk(' world'));

    const messages = translator.flush();
    expect(messages.length).toBe(1);
    expect(messages[0].type).toBe('assistant');
    expect(
      (messages[0] as { message: { content: { type: string; text: string }[] } }).message.content
    ).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  test('accumulates thinking chunks and emits before text', () => {
    translator.processUpdate(thoughtChunk('Let me think'));
    translator.processUpdate(agentChunk('Result'));

    const messages = translator.flush();
    expect(messages.length).toBe(1);
    const content = (messages[0] as { message: { content: { type: string }[] } }).message.content;
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'Let me think' });
    expect(content[1]).toEqual({ type: 'text', text: 'Result' });
  });

  test('flush returns empty array when nothing accumulated', () => {
    const messages = translator.flush();
    expect(messages.length).toBe(0);
  });

  test('flush clears buffers', () => {
    translator.processUpdate(agentChunk('text'));
    translator.flush();
    const second = translator.flush();
    expect(second.length).toBe(0);
  });

  test('flushes accumulated chunks before tool_call', () => {
    translator.processUpdate(agentChunk('Before tool'));

    const messages = translator.processUpdate(toolCall('tc-1', 'Read file', { path: '/tmp' }));

    expect(messages.length).toBe(2);
    expect(messages[0].type).toBe('assistant');
    expect(
      (messages[0] as { message: { content: { type: string; text: string }[] } }).message.content[0]
    ).toEqual({
      type: 'text',
      text: 'Before tool',
    });
    expect(messages[1].type).toBe('assistant');
    expect(
      (messages[1] as { message: { content: { type: string }[] } }).message.content[0].type
    ).toBe('tool_use');
  });

  test('flushes thinking and text before tool_call', () => {
    translator.processUpdate(thoughtChunk('thinking'));
    translator.processUpdate(agentChunk('text'));

    const messages = translator.processUpdate(toolCall('tc-1', 'Edit file', {}));

    expect(messages.length).toBe(2);
    const firstContent = (messages[0] as { message: { content: { type: string }[] } }).message
      .content;
    expect(firstContent.length).toBe(2);
    expect(firstContent[0].type).toBe('thinking');
    expect(firstContent[1].type).toBe('text');
  });

  test('translateToolCall produces tool_use block', () => {
    const msg = translator.translateToolCall(
      toolCall('tc-2', 'Write file', { path: '/tmp/f', content: 'hi' })
    );

    expect(msg.type).toBe('assistant');
    expect(msg.session_id).toBe('test-session');
    expect(msg.parent_tool_use_id).toBeNull();
    const content = (
      msg as { message: { content: { type: string; id: string; name: string; input: unknown }[] } }
    ).message.content;
    expect(content.length).toBe(1);
    expect(content[0]).toEqual({
      type: 'tool_use',
      id: 'tc-2',
      name: 'Write file',
      input: { path: '/tmp/f', content: 'hi' },
    });
  });

  test('translateToolCall defaults rawInput to empty object', () => {
    const msg = translator.translateToolCall(toolCall('tc-3', 'Search', undefined));
    const content = (msg as { message: { content: { input: unknown }[] } }).message.content;
    expect(content[0].input).toEqual({});
  });

  test('translateToolCallUpdate produces tool_progress message', () => {
    const msg = translator.translateToolCallUpdate(toolCallUpdate('tc-4', 'Running test'));

    expect(msg.type).toBe('tool_progress');
    expect(msg.session_id).toBe('test-session');
    expect(msg.tool_use_id).toBe('tc-4');
    expect(msg.tool_name).toBe('Running test');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.elapsed_time_seconds).toBe(0);
  });

  test('translateToolCallUpdate defaults title to unknown', () => {
    const msg = translator.translateToolCallUpdate(toolCallUpdate('tc-5', undefined));
    expect(msg.tool_name).toBe('unknown');
  });

  test('emits one tool_progress and one tool_result for a complete tool update', () => {
    const call = toolCall('tc-6', 'Read file', { path: '/tmp' });
    const start = translator.processUpdate(call);
    expect(start.length).toBe(1);
    expect(start[0].type).toBe('assistant');

    const progress = translator.processUpdate({
      ...toolCallUpdate('tc-6', undefined),
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
    });
    expect(progress.length).toBe(1);
    expect(progress[0].type).toBe('tool_progress');
    expect((progress[0] as { tool_name: string }).tool_name).toBe('Read file');

    const emptyUpdate = translator.processUpdate({
      ...toolCallUpdate('tc-6', undefined),
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: 'partial' } },
        { type: 'content', content: { type: 'text', text: ' output' } },
      ],
    });
    expect(emptyUpdate.length).toBe(0);

    const result = translator.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-6',
      title: undefined,
      status: 'completed',
    });
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('user');
    expect((result[0] as { parent_tool_use_id: string }).parent_tool_use_id).toBe('tc-6');
    const toolResult = result[0] as { tool_use_result: unknown };
    expect(toolResult.tool_use_result).toEqual([
      { type: 'content', content: { type: 'text', text: 'partial' } },
      { type: 'content', content: { type: 'text', text: ' output' } },
    ]);
  });

  test('flushes buffered non-terminal tool output once', () => {
    translator.processUpdate(toolCall('tc-partial', 'Partial tool', {}));
    translator.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-partial',
      status: 'in_progress',
      rawOutput: 'partial output',
    });

    const results = translator.flushToolResults();

    expect(results).toHaveLength(1);
    expect(results[0].parent_tool_use_id).toBe('tc-partial');
    expect(results[0].tool_use_result).toBe('partial output');
    expect(translator.flushToolResults()).toEqual([]);
  });

  test('does not duplicate terminal tool results when flushing', () => {
    translator.processUpdate(toolCall('tc-complete', 'Complete tool', {}));
    translator.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-complete',
      status: 'in_progress',
      rawOutput: 'complete output',
    });
    const result = translator.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-complete',
      status: 'completed',
    });

    expect(result).toHaveLength(1);
    expect(translator.flushToolResults()).toEqual([]);
  });

  test('emits a tool result for completed status without output', () => {
    translator.processUpdate(toolCall('tc-empty', 'No output', {}));

    const result = translator.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-empty',
      status: 'completed',
    });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('user');
    expect((result[0] as { tool_use_result: unknown }).tool_use_result).toBe('');
  });

  test('emits a tool result for failed status', () => {
    translator.processUpdate(toolCall('tc-failed', 'Failing tool', {}));

    const result = translator.processUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-failed',
      status: 'failed',
      rawOutput: 'failed output',
    });

    expect(result).toHaveLength(1);
    expect((result[0] as { tool_use_result: unknown }).tool_use_result).toBe('failed output');
  });

  test('translateResult produces success result', () => {
    const msg = translator.translateResult('end_turn');

    expect(msg.type).toBe('result');
    expect((msg as { subtype: string }).subtype).toBe('success');
    expect(msg.session_id).toBe('test-session');
    expect((msg as { is_error: boolean }).is_error).toBe(false);
  });

  test('translateResult produces error result when isError=true', () => {
    const msg = translator.translateResult('cancelled', true);

    expect((msg as { subtype: string }).subtype).toBe('error_during_execution');
    expect((msg as { is_error: boolean }).is_error).toBe(true);
    expect((msg as { errors: string[] }).errors).toContain('cancelled');
  });

  test('translates plan, config, mode, session info updates', () => {
    expect(translator.processUpdate({ sessionUpdate: 'plan', entries: [] } as never)[0].type).toBe(
      'assistant'
    );
    expect(
      translator.processUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'x',
      } as never)[0].type
    ).toBe('assistant');
    expect(
      translator.processUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [],
      } as never)
    ).toEqual([]);
    expect(
      translator.processUpdate({
        sessionUpdate: 'session_info_update',
        title: 'New title',
      } as never)[0].type
    ).toBe('assistant');
  });

  test('uses usage update in result message', () => {
    translator.processUpdate({ sessionUpdate: 'usage_update', size: 100, used: 80 } as never);
    const result = translator.translateResult('end_turn') as {
      usage: { input_tokens: number; output_tokens: number };
    };

    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  test('flushes buffered text before synthetic updates', () => {
    translator.processUpdate(agentChunk('Before'));

    const messages = translator.processUpdate({ sessionUpdate: 'plan', entries: [] } as never);

    expect(messages.length).toBe(2);
    expect(
      (messages[0] as { message: { content: { type: string; text: string }[] } }).message.content[0]
        .text
    ).toBe('Before');
    expect(
      (messages[1] as { message: { content: { type: string; text: string }[] } }).message.content[0]
        .text
    ).toContain('Plan:');
  });

  test('uses configured context window in usage estimate', () => {
    translator = new AcpMessageTranslator('test-session', 200000);
    translator.processUpdate(agentChunk('hello'));

    expect(translator.getContextUsage()?.size).toBe(200000);
  });

  test('does not add local output estimates to ACP usage totals', () => {
    translator.processUpdate(agentChunk('assistant text'));
    translator.processUpdate({ sessionUpdate: 'usage_update', size: 200000, used: 53000 } as never);

    expect(translator.getContextUsage()?.used).toBe(53000);
  });

  test('preserves zero ACP usage updates', () => {
    translator.processUpdate({ sessionUpdate: 'usage_update', size: 200000, used: 0 } as never);

    expect(translator.getContextUsage()).toEqual({ used: 0, size: 200000 });
  });

  test('translates available commands updates', () => {
    translator.processUpdate(agentChunk('Before'));

    const messages = translator.processUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        {
          name: 'review',
          description: 'Review the current changes',
          input: { hint: '[path]' },
        },
      ],
    } as never);

    expect(messages[0].type).toBe('assistant');
    expect(messages[1]).toMatchObject({
      type: 'system',
      subtype: 'commands_changed',
      session_id: 'test-session',
      commands: [
        {
          name: 'review',
          description: 'Review the current changes',
          argumentHint: '[path]',
        },
      ],
    });
  });
});

function agentChunk(text: string): AcpAgentMessageChunkUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  };
}

function thoughtChunk(text: string): AcpAgentThoughtChunkUpdate {
  return {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text },
  };
}

function toolCall(
  toolCallId: string,
  title: string,
  rawInput: Record<string, unknown> | undefined
): AcpToolCallUpdateNotification {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title,
    rawInput,
  };
}

function toolCallUpdate(toolCallId: string, title: string | undefined): AcpToolCallUpdateUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    title,
  };
}
