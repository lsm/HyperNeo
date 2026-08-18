import { describe, expect, it } from 'vitest';
import { buildThreadEvents, parseThreadRow } from '../thread/space-task-thread-events';
import type { SpaceTaskThreadMessageRow } from '../../../hooks/useSpaceTaskMessages';

function makeRow(
  overrides: Partial<SpaceTaskThreadMessageRow> & { content: string }
): SpaceTaskThreadMessageRow {
  return {
    id: 'row-default',
    sessionId: 'session-1',
    kind: 'task_agent',
    role: 'task',
    label: 'Task Agent',
    taskId: 'task-1',
    taskTitle: 'Test Task',
    messageType: 'assistant',
    createdAt: 1_710_000_000_000,
    ...overrides,
  } as SpaceTaskThreadMessageRow;
}

function makeAssistantRow(
  id: string,
  label: string,
  kind: string,
  text: string,
  createdAt: number,
  sessionId = 'session-1'
): SpaceTaskThreadMessageRow {
  return makeRow({
    id,
    sessionId,
    kind: kind as 'task_agent' | 'node_agent',
    label,
    content: JSON.stringify({
      type: 'assistant',
      uuid: `uuid-${id}`,
      session_id: sessionId,
      message: {
        content: [{ type: 'text', text }],
      },
    }),
    createdAt,
  });
}

describe('parseThreadRow', () => {
  it('parses a valid JSON assistant message row', () => {
    const row = makeAssistantRow(
      'r1',
      'Task Agent',
      'task_agent',
      'Hello world',
      1_710_000_000_000
    );
    const parsed = parseThreadRow(row);
    expect(parsed.id).toBe('r1');
    expect(parsed.label).toBe('Task Agent');
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.createdAt).toBe(1_710_000_000_000);
    expect(parsed.message).not.toBeNull();
    expect(parsed.fallbackText).toBeNull();
  });

  it('injects timestamp from createdAt into parsed message', () => {
    const row = makeAssistantRow('r1', 'Task Agent', 'task_agent', 'Hello', 1_710_000_999_000);
    const parsed = parseThreadRow(row);
    expect((parsed.message as Record<string, unknown>)?.timestamp).toBe(1_710_000_999_000);
  });

  it('injects DB origin from the row into the parsed message', () => {
    const row = makeRow({
      id: 'system-row',
      origin: 'system',
      content: JSON.stringify({
        type: 'user',
        uuid: 'u-system',
        session_id: 'session-1',
        message: { content: 'runtime notification' },
      }),
    });

    const parsed = parseThreadRow(row);

    expect((parsed.message as Record<string, unknown>)?.origin).toBe('system');
  });

  it('returns fallbackText when content is not valid JSON', () => {
    const invalidContent = 'not json {{{';
    const row = makeRow({ id: 'bad', content: invalidContent });
    const parsed = parseThreadRow(row);
    expect(parsed.message).toBeNull();
    expect(parsed.fallbackText).toBe(invalidContent);
  });

  it('preserves label and sessionId from the original row', () => {
    const row = makeAssistantRow(
      'r2',
      'Coder Agent',
      'node_agent',
      'coding',
      1_000,
      'session-coder'
    );
    const parsed = parseThreadRow(row);
    expect(parsed.label).toBe('Coder Agent');
    expect(parsed.sessionId).toBe('session-coder');
  });
});

describe('buildThreadEvents — multi-agent ordering and label preservation', () => {
  it('produces events in the same order as input rows', () => {
    const rows = [
      makeAssistantRow('r1', 'Task Agent', 'task_agent', 'Task is planning', 1_000),
      makeAssistantRow(
        'r2',
        'Coder Agent',
        'node_agent',
        'Coder is coding',
        2_000,
        'session-coder'
      ),
      makeAssistantRow(
        'r3',
        'Reviewer Agent',
        'node_agent',
        'Reviewer reviewing',
        3_000,
        'session-reviewer'
      ),
    ];
    const parsed = rows.map(parseThreadRow);
    const events = buildThreadEvents(parsed);

    const textEvents = events.filter((e) => e.kind === 'text');
    expect(textEvents).toHaveLength(3);
    expect(textEvents[0].summary).toContain('Task is planning');
    expect(textEvents[1].summary).toContain('Coder is coding');
    expect(textEvents[2].summary).toContain('Reviewer reviewing');
  });

  it('preserves agent label on each event', () => {
    const rows = [
      makeAssistantRow('r1', 'Task Agent', 'task_agent', 'Task text', 1_000),
      makeAssistantRow('r2', 'Coder Agent', 'node_agent', 'Coder text', 2_000, 'session-coder'),
    ];
    const events = buildThreadEvents(rows.map(parseThreadRow));
    const textEvents = events.filter((e) => e.kind === 'text');
    expect(textEvents[0].label).toBe('Task Agent');
    expect(textEvents[1].label).toBe('Coder Agent');
  });

  it('preserves sessionId on events', () => {
    const rows = [
      makeAssistantRow('r1', 'Task Agent', 'task_agent', 'Task text', 1_000, 'task-session'),
      makeAssistantRow('r2', 'Coder Agent', 'node_agent', 'Coder text', 2_000, 'coder-session'),
    ];
    const events = buildThreadEvents(rows.map(parseThreadRow));
    const textEvents = events.filter((e) => e.kind === 'text');
    expect(textEvents[0].sessionId).toBe('task-session');
    expect(textEvents[1].sessionId).toBe('coder-session');
  });

  it('expands multi-block assistant messages into separate events per block', () => {
    const row = makeRow({
      id: 'multi-block',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        session_id: 'session-1',
        message: {
          content: [
            { type: 'thinking', thinking: 'Thinking now' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'All done.' },
          ],
        },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe('thinking');
    expect(events[1].kind).toBe('tool');
    expect(events[2].kind).toBe('text');
  });

  it('skips empty Opus 4.7 "omitted" thinking stubs (empty thinking + signature)', () => {
    const row = makeRow({
      id: 'opus-47-omitted',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        session_id: 'session-1',
        message: {
          content: [
            { type: 'thinking', thinking: '', signature: 'sig_abc123' },
            { type: 'text', text: 'Here is my response.' },
          ],
        },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text');
    expect(events.some((e) => e.kind === 'thinking')).toBe(false);
  });

  it('skips whitespace-only thinking payloads', () => {
    const row = makeRow({
      id: 'whitespace-thinking',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        session_id: 'session-1',
        message: {
          content: [
            { type: 'thinking', thinking: '   \n\t  ' },
            { type: 'text', text: 'Done.' },
          ],
        },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events.some((e) => e.kind === 'thinking')).toBe(false);
  });

  it('all events from a multi-block message share the same label', () => {
    const row = makeRow({
      id: 'multi-block-2',
      label: 'Coder Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        session_id: 'session-coder',
        message: {
          content: [
            { type: 'thinking', thinking: 'Planning' },
            { type: 'text', text: 'Done coding.' },
          ],
        },
      }),
      createdAt: 2_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events.every((e) => e.label === 'Coder Agent')).toBe(true);
  });

  it('interleaved messages from two agents preserve chronological label sequence', () => {
    const rows = [
      makeAssistantRow('t1', 'Task Agent', 'task_agent', 'Step 1', 1_000),
      makeAssistantRow('c1', 'Coder Agent', 'node_agent', 'Step 2', 2_000, 'coder-session'),
      makeAssistantRow('t2', 'Task Agent', 'task_agent', 'Step 3', 3_000),
      makeAssistantRow('c2', 'Coder Agent', 'node_agent', 'Step 4', 4_000, 'coder-session'),
    ];
    const events = buildThreadEvents(rows.map(parseThreadRow));
    const textEvents = events.filter((e) => e.kind === 'text');
    expect(textEvents.map((e) => e.label)).toEqual([
      'Task Agent',
      'Coder Agent',
      'Task Agent',
      'Coder Agent',
    ]);
  });

  it('handles a fallback (invalid JSON) row as unknown kind', () => {
    const row = makeRow({ id: 'bad', content: '!invalid!' });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('unknown');
    expect(events[0].label).toBe('Task Agent');
  });

  it('treats Task tool_use block as subagent kind', () => {
    const row = makeRow({
      id: 'subagent-row',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'a3',
        session_id: 'session-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'su1',
              name: 'Task',
              input: {
                subagent_type: 'coder-agent',
                description: 'Write the feature',
              },
            },
          ],
        },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('subagent');
    expect(events[0].title).toBe('Sub-agent');
  });

  it('produces result event with token summary from usage', () => {
    const row = makeRow({
      id: 'success-result',
      label: 'Task Agent',
      messageType: 'result',
      content: JSON.stringify({
        type: 'result',
        subtype: 'success',
        uuid: 'r1',
        session_id: 'session-1',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('result');
    expect(events[0].summary).toContain('100→50 tokens');
  });

  it('produces result event with dash summary when usage is missing', () => {
    const row = makeRow({
      id: 'no-usage-result',
      label: 'Task Agent',
      messageType: 'result',
      content: JSON.stringify({
        type: 'result',
        subtype: 'success',
        uuid: 'r2',
        session_id: 'session-1',
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('result');
    expect(events[0].summary).toBe('— tokens');
  });

  it('produces result event with error flag for non-success result', () => {
    const row = makeRow({
      id: 'err-result',
      label: 'Task Agent',
      messageType: 'result',
      content: JSON.stringify({
        type: 'result',
        subtype: 'error',
        uuid: 'r1',
        session_id: 'session-1',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('result');
    expect(events[0].isError).toBe(true);
    expect(events[0].title).toBe('Error');
  });

  it('produces rate_limit event with isError=true for rejected status', () => {
    const row = makeRow({
      id: 'rl-rejected',
      label: 'Coder Agent',
      messageType: 'rate_limit_event',
      content: JSON.stringify({
        type: 'rate_limit_event',
        uuid: 'rl1',
        session_id: 'session-1',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('rate_limit');
    expect(events[0].isError).toBe(true);
    expect(events[0].label).toBe('Coder Agent');
  });

  it('produces rate_limit event with isError=false for allowed status', () => {
    const row = makeRow({
      id: 'rl-allowed',
      label: 'Task Agent',
      messageType: 'rate_limit_event',
      content: JSON.stringify({
        type: 'rate_limit_event',
        uuid: 'rl2',
        session_id: 'session-1',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('rate_limit');
    expect(events[0].isError).toBe(false);
  });

  it('produces empty placeholder event when assistant message has no content blocks', () => {
    const row = makeRow({
      id: 'empty-assistant',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'ae1',
        session_id: 'session-1',
        message: { content: [] },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text');
    expect(events[0].summary).toBe('Assistant updated context');
  });

  it('produces user event for user message type', () => {
    const row = makeRow({
      id: 'user-msg',
      label: 'Task Agent',
      messageType: 'user',
      content: JSON.stringify({
        type: 'user',
        uuid: 'u1',
        session_id: 'session-1',
        message: { content: 'Please help me.' },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('user');
    expect(events[0].summary).toBe('Please help me.');
  });

  it('reshapes request_human_input tool_use into a visible text Question event', () => {
    const row = makeRow({
      id: 'hi-row',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'hi1',
        session_id: 'session-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't-hi-1',
              name: 'request_human_input',
              input: { question: 'Proceed with deploy?', context: 'PR is green.' },
            },
          ],
        },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('text');
    expect(events[0].title).toBe('Question');
    expect(events[0].summary).toContain('Proceed with deploy?');
    expect(events[0].summary).toContain('Context: PR is green.');
    const synthesized = events[0].message as { message?: { content?: unknown[] } };
    const content = synthesized.message?.content ?? [];
    expect(content).toHaveLength(1);
    expect((content[0] as { type: string }).type).toBe('text');
    expect(content.some((b) => (b as { type: string }).type === 'tool_use')).toBe(false);
  });

  it('skips request_human_input when the question body is empty', () => {
    const row = makeRow({
      id: 'hi-empty',
      label: 'Task Agent',
      content: JSON.stringify({
        type: 'assistant',
        uuid: 'hi2',
        session_id: 'session-1',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't-hi-2',
              name: 'request_human_input',
              input: { question: '   ' },
            },
          ],
        },
      }),
      createdAt: 1_000,
    });
    const events = buildThreadEvents([parseThreadRow(row)]);
    expect(events[0].kind).toBe('tool');
  });

  it('handles mixed agent rows with tool events maintaining correct labels', () => {
    const rows = [
      makeRow({
        id: 'tool-row',
        label: 'Coder Agent',
        content: JSON.stringify({
          type: 'assistant',
          uuid: 'a4',
          session_id: 'coder-session',
          message: {
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } },
              { type: 'text', text: 'Tests passed.' },
            ],
          },
        }),
        createdAt: 1_000,
      }),
    ];
    const events = buildThreadEvents(rows.map(parseThreadRow));
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('tool');
    expect(events[0].label).toBe('Coder Agent');
    expect(events[1].kind).toBe('text');
    expect(events[1].label).toBe('Coder Agent');
  });
});
