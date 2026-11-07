import { describe, expect, it } from 'vitest';
import {
  translateOapEvent,
  initialOapTranslatorState,
} from '../../../../src/lib/oap/oap-sdk-translator';

describe('translateOapEvent', () => {
  it('translates text and emits exactly one terminal result', () => {
    const state = initialOapTranslatorState('session-1');
    const text = translateOapEvent(state, {
      type: 'content.delta',
      id: 'event-1',
      payload: { part: { type: 'text', text: 'hello' } },
    });
    expect(text.messages[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    const completed = translateOapEvent(text.state, {
      type: 'run.completed',
      id: 'event-2',
      payload: { stop_reason: 'end_turn' },
    });
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
    });
    expect(
      translateOapEvent(completed.state, { type: 'run.completed', id: 'event-3', payload: {} })
        .messages
    ).toEqual([]);
    expect(
      translateOapEvent(completed.state, {
        type: 'content.delta',
        id: 'event-4',
        payload: { part: { type: 'text', text: 'late' } },
      }).messages
    ).toEqual([]);
  });
  it('translates a failed run into an error result', () => {
    const result = translateOapEvent(initialOapTranslatorState('session-1'), {
      type: 'run.failed',
      id: 'event-5',
      payload: { error: { message: 'failed' } },
    });
    expect(result.messages[0]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['failed'],
    });
  });
  it('preserves separate text deltas and drops unsupported parts', () => {
    const state = initialOapTranslatorState('session-1');
    const first = translateOapEvent(state, {
      type: 'content.delta',
      id: 'event-1',
      payload: { part: { type: 'text', text: 'A' } },
    });
    const second = translateOapEvent(first.state, {
      type: 'content.delta',
      id: 'event-2',
      payload: { part: { type: 'text', text: 'B' } },
    });
    expect(first.messages[0]).toMatchObject({ message: { content: [{ text: 'A' }] } });
    expect(second.messages[0]).toMatchObject({ message: { content: [{ text: 'B' }] } });
    expect(first.messages[0]?.uuid).not.toEqual(second.messages[0]?.uuid);
    expect(
      translateOapEvent(state, {
        type: 'content.delta',
        id: 'event-3',
        payload: { part: { type: 'image' } },
      }).messages
    ).toEqual([]);
    expect(state.terminal).toBe(false);
  });
  it('settles a cancelled run once with its reason', () => {
    const cancelled = translateOapEvent(initialOapTranslatorState('session-1'), {
      type: 'run.cancelled',
      id: 'event-7',
      payload: { reason: 'native turn interrupted' },
    });
    expect(cancelled.messages).toMatchObject([
      { type: 'result', is_error: true, errors: ['native turn interrupted'] },
    ]);
    expect(
      translateOapEvent(cancelled.state, { type: 'run.failed', id: 'event-8', payload: {} })
        .messages
    ).toEqual([]);
  });
});

const commandFixture = [
  {
    protocol: 'open-agent-protocol',
    version: '0.1',
    profile: 'open-agent-protocol.agent-control-core',
    type: 'action.call.requested',
    id: 'event-07',
    payload: {
      session_id: 'session-1',
      run_id: 'run-02',
      tool_call_id: 'tool-call-06',
      requested_by: 'codex.app-server',
      execution_owner: 'codex.app-server',
      name: 'codex.command',
      arguments_json: {
        command: 'true',
        cwd: '',
      },
    },
    sequence: 2,
    timestamp_ms: 6,
    session_id: 'session-1',
    run_id: 'run-02',
    tool_call_id: 'tool-call-06',
    capability_revision: 'codex-appserver-0.163.0-oap-v2',
  },
  {
    protocol: 'open-agent-protocol',
    version: '0.1',
    profile: 'open-agent-protocol.agent-control-core',
    type: 'action.call.started',
    id: 'event-08',
    payload: {
      session_id: 'session-1',
      run_id: 'run-02',
      tool_call_id: 'tool-call-06',
      requested_by: 'codex.app-server',
      execution_owner: 'codex.app-server',
      name: 'codex.command',
      arguments_json: {
        command: 'true',
        cwd: '',
      },
    },
    sequence: 3,
    timestamp_ms: 7,
    session_id: 'session-1',
    run_id: 'run-02',
    tool_call_id: 'tool-call-06',
    capability_revision: 'codex-appserver-0.163.0-oap-v2',
  },
  {
    protocol: 'open-agent-protocol',
    version: '0.1',
    profile: 'open-agent-protocol.agent-control-core',
    type: 'action.call.completed',
    id: 'event-09',
    payload: {
      session_id: 'session-1',
      run_id: 'run-02',
      tool_call_id: 'tool-call-06',
      requested_by: 'codex.app-server',
      execution_owner: 'codex.app-server',
      name: 'codex.command',
      result: {
        command: 'true',
        cwd: '',
        exitCode: null,
        output: 'ok',
      },
    },
    sequence: 4,
    timestamp_ms: 8,
    session_id: 'session-1',
    run_id: 'run-02',
    tool_call_id: 'tool-call-06',
    capability_revision: 'codex-appserver-0.163.0-oap-v2',
  },
];
const usageFixture = {
  protocol: 'open-agent-protocol',
  version: '0.1',
  profile: 'open-agent-protocol.agent-control-core',
  type: 'run.completed',
  id: 'event-07',
  payload: {
    session_id: 'session-1',
    run_id: 'run-02',
    final_response: {
      id: 'message-03',
      role: 'assistant',
      content: 'fixture-ok',
    },
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 2500,
      output_tokens: 100,
      total_tokens: 2600,
    },
  },
  sequence: 3,
  timestamp_ms: 7,
  session_id: 'session-1',
  run_id: 'run-02',
  capability_revision: 'codex-appserver-0.163.0-oap-v2',
};

describe('translateOapEvent tool and usage fixtures', () => {
  it('pairs requested and completed calls without duplicating started events', () => {
    const [requested, started, completed] = commandFixture;
    const first = translateOapEvent(initialOapTranslatorState('session-1'), requested);
    expect(first.messages).toMatchObject([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-call-06',
              name: 'codex.command',
              input: { command: 'true', cwd: '' },
            },
          ],
        },
      },
    ]);
    const next = translateOapEvent(first.state, started);
    expect(next.messages).toEqual([]);
    const last = translateOapEvent(next.state, completed);
    expect(last.messages).toMatchObject([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-call-06',
              content: '{"command":"true","cwd":"","exitCode":null,"output":"ok"}',
            },
          ],
        },
      },
    ]);
    expect(translateOapEvent(last.state, completed).messages).toEqual([]);
  });
  it('preserves fixture usage on the terminal result', () => {
    expect(
      translateOapEvent(initialOapTranslatorState('session-1'), usageFixture).messages
    ).toMatchObject([{ type: 'result', usage: { input_tokens: 2500, output_tokens: 100 } }]);
  });
  it('translates an OAP reasoning content part as SDK thinking', () => {
    const event = {
      type: 'content.delta',
      id: 'reason-1',
      payload: {
        session_id: 'session-1',
        run_id: 'run-02',
        message_id: 'message-03',
        part: { type: 'reasoning', reasoning: 'consider options' },
      },
    };
    expect(translateOapEvent(initialOapTranslatorState('session-1'), event).messages).toMatchObject(
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'thinking', thinking: 'consider options' }] },
        },
      ]
    );
  });
});

describe('translateOapEvent tool lifecycle', () => {
  it('keeps interleaved calls distinct and marks failed results', () => {
    const [request] = commandFixture;
    const first = translateOapEvent(initialOapTranslatorState('session-1'), request);
    const other = {
      ...request,
      id: 'event-other',
      payload: { ...request.payload, tool_call_id: 'other' },
    };
    const second = translateOapEvent(first.state, other);
    const failed = translateOapEvent(second.state, {
      type: 'action.call.failed',
      id: 'failure',
      payload: { tool_call_id: 'tool-call-06', error: { code: 'failed', message: 'no' } },
    });
    expect(failed.messages).toMatchObject([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-call-06',
              is_error: true,
              content: '{"code":"failed","message":"no"}',
            },
          ],
        },
      },
    ]);
    const completed = translateOapEvent(failed.state, {
      type: 'action.call.completed',
      id: 'done',
      payload: { tool_call_id: 'other', result: 'ok' },
    });
    expect(completed.messages).toMatchObject([
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'other', is_error: false, content: 'ok' }],
        },
      },
    ]);
    expect(translateOapEvent(completed.state, other).messages).toEqual([]);
    expect(first.state.tools).toEqual([{ id: 'tool-call-06', settled: false }]);
  });
  it('maps cache and reasoning usage and rejects invalid counts', () => {
    const event = {
      ...usageFixture,
      payload: {
        ...usageFixture.payload,
        usage: {
          input_tokens: 8,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_write_input_tokens: 2,
          reasoning_tokens: 4,
        },
      },
    };
    expect(translateOapEvent(initialOapTranslatorState('session-1'), event).messages).toMatchObject(
      [
        {
          usage: {
            input_tokens: 8,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
            output_tokens_details: { thinking_tokens: 4 },
          },
        },
      ]
    );
    const invalid = {
      ...event,
      payload: { ...event.payload, usage: { input_tokens: -1, output_tokens: 1.5 } },
    };
    expect(
      translateOapEvent(initialOapTranslatorState('session-1'), invalid).messages
    ).toMatchObject([{ usage: { input_tokens: 0, output_tokens: 0 } }]);
  });
  it('creates a pair for a terminal call when its start was not observed', () => {
    const event = { ...commandFixture[2], id: 'isolated' };
    const result = translateOapEvent(initialOapTranslatorState('session-1'), event);
    expect(result.messages).toMatchObject([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-call-06', name: 'codex.command' }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-call-06' }] },
      },
    ]);
    expect(result.messages[0]?.uuid).not.toEqual(result.messages[1]?.uuid);
  });
  it('retains a null tool argument instead of replacing it', () => {
    const event = {
      ...commandFixture[0],
      payload: { ...commandFixture[0].payload, arguments_json: null },
    };
    expect(translateOapEvent(initialOapTranslatorState('session-1'), event).messages).toMatchObject(
      [{ message: { content: [{ type: 'tool_use', input: null }] } }]
    );
  });
});
