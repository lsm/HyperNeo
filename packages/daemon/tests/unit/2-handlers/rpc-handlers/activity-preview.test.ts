import { describe, test, expect } from 'bun:test';
import {
  buildActiveTurnSummariesFromRows,
  mapActiveTurnEntryRow,
} from '../../../../src/lib/rpc-handlers/activity-preview';
import { buildActiveTurnSummariesFromRows as fromFacade } from '../../../../src/lib/rpc-handlers/live-query-handlers';

type Row = Record<string, unknown>;

function row(overrides: Row): Row {
  return {
    sessionId: 's1',
    turnIndex: 0,
    ts: 100,
    uuid: 'u1',
    rowId: 'r1',
    blockIdx: 0,
    id: 'id1',
    ...overrides,
  };
}

function toolRow(toolName: string, input: Row, overrides: Row = {}): Row {
  return row({
    blockType: 'tool_use',
    toolName,
    toolInput: JSON.stringify(input),
    toolUseId: 'tu1',
    ...overrides,
  });
}

function previewOf(toolName: string, input: Row): string {
  const mapped = mapActiveTurnEntryRow(toolRow(toolName, input)) as {
    entry: { preview?: string } | null;
  };
  return (mapped.entry as { preview?: string })?.preview ?? '<no-entry>';
}

describe('activity-preview facade re-export', () => {
  test('buildActiveTurnSummariesFromRows is re-exported from live-query-handlers', () => {
    expect(fromFacade).toBe(buildActiveTurnSummariesFromRows);
  });
});

describe('mapActiveTurnEntryRow: tool_use previews', () => {
  test('Bash prefers description over command', () => {
    expect(previewOf('Bash', { description: '  run   tests  ', command: 'npm test' })).toBe(
      'run tests'
    );
  });

  test('Bash falls back to command when description is absent', () => {
    expect(previewOf('Bash', { command: 'git status' })).toBe('git status');
  });

  test('file tools render the path basename', () => {
    expect(previewOf('Write', { file_path: '/a/b/c.ts' })).toBe('c.ts');
    expect(previewOf('Edit', { file_path: '/a/b/c.ts' })).toBe('c.ts');
    expect(previewOf('MultiEdit', { file_path: '/a/b/d.go' })).toBe('d.go');
    expect(previewOf('Read', { file_path: '/a/b/e.md' })).toBe('e.md');
    expect(previewOf('NotebookEdit', { notebook_path: '/x/y.ipynb' })).toBe('y.ipynb');
  });

  test('file tools with no path produce an empty preview', () => {
    expect(previewOf('Write', {})).toBe('');
  });

  test('search tools cap the pattern/query/url at 50', () => {
    const long = 'x'.repeat(80);
    const expected = `${'x'.repeat(49)}…`;
    expect(previewOf('Glob', { pattern: long })).toBe(expected);
    expect(previewOf('Grep', { pattern: long })).toBe(expected);
    expect(previewOf('WebFetch', { url: long })).toBe(expected);
    expect(previewOf('WebSearch', { query: long })).toBe(expected);
  });

  test('Task/Agent use description with fallbacks', () => {
    expect(previewOf('Task', { description: 'do thing' })).toBe('do thing');
    expect(previewOf('Task', {})).toBe('Task execution');
    expect(previewOf('Agent', {})).toBe('Agent execution');
  });

  test('TaskOutput/TaskStop use task_id / shell_id', () => {
    expect(previewOf('TaskOutput', { task_id: 't1' })).toBe('t1');
    expect(previewOf('TaskOutput', {})).toBe('Task output');
    expect(previewOf('TaskStop', { task_id: 't2' })).toBe('t2');
    expect(previewOf('TaskStop', { shell_id: 'sh1' })).toBe('sh1');
    expect(previewOf('TaskStop', {})).toBe('Stop task');
  });

  test('BashOutput/KillShell show truncated shell id', () => {
    expect(previewOf('BashOutput', { bash_id: 'abcdef1234567890' })).toBe('Shell: abcdef12');
    expect(previewOf('BashOutput', {})).toBe('Shell: unknown');
    expect(previewOf('KillShell', { shell_id: '0123456789' })).toBe('Shell: 01234567');
    expect(previewOf('KillShell', {})).toBe('Shell: unknown');
  });

  test('mcp__ tools produce an empty preview', () => {
    expect(previewOf('mcp__foo__bar', { some: 'input' })).toBe('');
  });

  test('MCP resource tools', () => {
    expect(previewOf('ListMcpResourcesTool', { server: 'srv' })).toBe('srv');
    expect(previewOf('ListMcpResourcesTool', {})).toBe('All servers');
    expect(previewOf('ReadMcpResourceTool', { uri: 'u'.repeat(80) })).toBe(`${'u'.repeat(49)}…`);
  });

  test('plan-mode tools return fixed labels', () => {
    expect(previewOf('EnterPlanMode', {})).toBe('Entering plan mode');
    expect(previewOf('ExitPlanMode', {})).toBe('Exiting plan mode');
  });

  test('TimeMachine uses message_prefix capped at 40', () => {
    const long = 'p'.repeat(80);
    expect(previewOf('TimeMachine', { message_prefix: long })).toBe(`${'p'.repeat(39)}…`);
    expect(previewOf('TimeMachine', { message_prefix: '  rewind  ' })).toBe('rewind');
  });

  test('unknown tool with a string first value one-lines it at 40', () => {
    const long = 'z'.repeat(80);
    expect(previewOf('CustomTool', { msg: long })).toBe(`${'z'.repeat(39)}…`);
    expect(previewOf('CustomTool', { msg: '  hi  there ' })).toBe('hi there');
  });

  test('unknown tool with a non-string first value shows key placeholder', () => {
    expect(previewOf('CustomTool', { count: 5 })).toBe('count: …');
  });

  test('unknown tool with empty input produces an empty preview', () => {
    expect(previewOf('CustomTool', {})).toBe('');
  });
});

describe('mapActiveTurnEntryRow: TodoWrite previews', () => {
  test('in_progress todo wins and uses activeForm then content', () => {
    expect(
      previewOf('TodoWrite', {
        todos: [{ status: 'in_progress', activeForm: 'Writing code', content: 'c' }],
      })
    ).toBe('Running: Writing code');
    expect(
      previewOf('TodoWrite', { todos: [{ status: 'in_progress', content: 'just content' }] })
    ).toBe('Running: just content');
  });

  test('most-recent completed todo is marked done', () => {
    expect(
      previewOf('TodoWrite', {
        todos: [
          { status: 'completed', content: 'old' },
          { status: 'completed', content: 'recent' },
        ],
      })
    ).toBe('Marked done: recent');
  });

  test('first pending todo is added', () => {
    expect(previewOf('TodoWrite', { todos: [{ status: 'pending', content: 'a task' }] })).toBe(
      'Added task: a task'
    );
  });

  test('count fallback pluralizes correctly', () => {
    expect(previewOf('TodoWrite', { todos: [{ status: 'pending' }] })).toBe('1 todo');
    expect(previewOf('TodoWrite', { todos: [{ status: 'pending' }, { status: 'pending' }] })).toBe(
      '2 todos'
    );
  });

  test('empty / non-array todos fall back to "Update todos"', () => {
    expect(previewOf('TodoWrite', { todos: [] })).toBe('Update todos');
    expect(previewOf('TodoWrite', {})).toBe('Update todos');
  });
});

describe('mapActiveTurnEntryRow: AskUserQuestion previews', () => {
  test('single question shows its text capped at 60', () => {
    expect(previewOf('AskUserQuestion', { questions: [{ question: 'which one?' }] })).toBe(
      'which one?'
    );
    const long = 'q'.repeat(80);
    expect(previewOf('AskUserQuestion', { questions: [{ question: long }] })).toBe(
      `${'q'.repeat(59)}…`
    );
  });

  test('multiple questions append a (+N) suffix', () => {
    expect(
      previewOf('AskUserQuestion', {
        questions: [{ question: 'a' }, { question: 'b' }, { question: 'c' }],
      })
    ).toBe('a (+2)');
  });

  test('questions without text fall back to count', () => {
    expect(previewOf('AskUserQuestion', { questions: [{}, {}] })).toBe('2 questions');
  });

  test('empty / non-array questions fall back to "Ask user"', () => {
    expect(previewOf('AskUserQuestion', { questions: [] })).toBe('Ask user');
    expect(previewOf('AskUserQuestion', {})).toBe('Ask user');
  });
});

describe('mapActiveTurnEntryRow: non-tool blocks', () => {
  test('text block is collapsed to one line', () => {
    const mapped = mapActiveTurnEntryRow(
      row({ blockType: 'text', textValue: 'line one\n line two ' })
    ) as {
      entry: Record<string, unknown> | null;
    };
    expect(mapped.entry).toEqual({ kind: 'text', text: 'line one line two', ts: 100, uuid: 'u1' });
  });

  test('whitespace-only text block yields a null entry', () => {
    const mapped = mapActiveTurnEntryRow(row({ blockType: 'text', textValue: '   ' })) as {
      entry: null;
    };
    expect(mapped.entry).toBeNull();
  });

  test('thinking block is trimmed (not one-lined)', () => {
    const mapped = mapActiveTurnEntryRow(
      row({ blockType: 'thinking', thinkingValue: '  a thought\n  ' })
    ) as {
      entry: Record<string, unknown> | null;
    };
    expect(mapped.entry).toEqual({ kind: 'thinking', preview: 'a thought', ts: 100, uuid: 'u1' });
  });

  test('__user_message and __user_replay map to their kinds', () => {
    const um = mapActiveTurnEntryRow(row({ blockType: '__user_message', textValue: 'hello' })) as {
      entry: Record<string, unknown> | null;
    };
    expect(um.entry).toEqual({ kind: 'user_message', text: 'hello', ts: 100, uuid: 'u1' });
    const ur = mapActiveTurnEntryRow(row({ blockType: '__user_replay', textValue: 'handoff' })) as {
      entry: Record<string, unknown> | null;
    };
    expect(ur.entry).toEqual({ kind: 'agent_handoff', text: 'handoff', ts: 100, uuid: 'u1' });
  });

  test('__hook coerces unknown status to running and carries optional summary', () => {
    const running = mapActiveTurnEntryRow(
      row({ blockType: '__hook', toolName: 'PreToolUse', hookEvent: 'before', hookStatus: 'weird' })
    ) as { entry: Record<string, unknown> | null };
    expect(running.entry).toMatchObject({ kind: 'hook', status: 'running' });
    expect(running.entry).not.toHaveProperty('summary');

    const done = mapActiveTurnEntryRow(
      row({
        blockType: '__hook',
        toolName: 'PostToolUse',
        hookEvent: 'after',
        hookStatus: 'completed',
        textValue: '  build ok  ',
      })
    ) as { entry: Record<string, unknown> | null };
    expect(done.entry).toMatchObject({ kind: 'hook', status: 'completed', summary: 'build ok' });
  });

  test('__api_retry normalizes numeric fields and null errorStatus', () => {
    const mapped = mapActiveTurnEntryRow(
      row({
        blockType: '__api_retry',
        attempt: '3',
        maxRetries: 5,
        retryDelayMs: 1200,
        errorStatus: null,
      })
    ) as { entry: Record<string, unknown> | null };
    expect(mapped.entry).toEqual({
      kind: 'api_retry',
      attempt: 3,
      maxRetries: 5,
      retryDelayMs: 1200,
      errorStatus: null,
      ts: 100,
      uuid: 'u1',
    });
  });
});

describe('mapActiveTurnEntryRow: toolInput parsing & id fallback', () => {
  test('toolInput can be a pre-parsed object', () => {
    const mapped = mapActiveTurnEntryRow(
      row({ blockType: 'tool_use', toolName: 'Bash', toolInput: { description: 'parsed' } })
    ) as { entry: Record<string, unknown> | null };
    expect((mapped.entry as { preview: string }).preview).toBe('parsed');
  });

  test('malformed JSON toolInput leaves input empty', () => {
    const mapped = mapActiveTurnEntryRow(
      row({ blockType: 'tool_use', toolName: 'Bash', toolInput: '{not json' })
    ) as { entry: Record<string, unknown> | null };
    expect((mapped.entry as { preview: string }).preview).toBe('');
  });

  test('toolUseId is omitted when absent', () => {
    const without = mapActiveTurnEntryRow(
      toolRow('Bash', { command: 'x' }, { toolUseId: undefined })
    ) as {
      entry: Record<string, unknown> | null;
    };
    expect(without.entry).not.toHaveProperty('toolUseId');
  });

  test('id falls back to a composite when not a string', () => {
    const mapped = mapActiveTurnEntryRow(
      row({
        blockType: 'text',
        textValue: 'hi',
        id: undefined,
        sessionId: 's9',
        turnIndex: 2,
        rowId: 'r9',
        blockIdx: 4,
      })
    ) as { id: string };
    expect(mapped.id).toBe('s9:2:r9:4');
  });
});

describe('buildActiveTurnSummariesFromRows: aggregation', () => {
  test('groups rows by sessionId preserving row order and turnIndex', () => {
    const summaries = buildActiveTurnSummariesFromRows([
      row({ sessionId: 'a', turnIndex: 1, blockType: 'text', textValue: 'first' }),
      row({ sessionId: 'a', turnIndex: 1, blockType: 'text', textValue: 'second' }),
      row({ sessionId: 'b', turnIndex: 3, blockType: '__user_message', textValue: 'hi' }),
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ sessionId: 'a', turnIndex: 1 });
    expect((summaries[0].entries[0] as { text: string }).text).toBe('first');
    expect((summaries[0].entries[1] as { text: string }).text).toBe('second');
    expect(summaries[1]).toMatchObject({ sessionId: 'b', turnIndex: 3 });
  });

  test('rows without a string sessionId are skipped', () => {
    const summaries = buildActiveTurnSummariesFromRows([
      row({ sessionId: undefined, blockType: 'text', textValue: 'nope' }),
      row({ sessionId: 'a', blockType: 'text', textValue: 'yes' }),
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].sessionId).toBe('a');
  });

  test('empty text/thinking rows are dropped mid-aggregation', () => {
    const summaries = buildActiveTurnSummariesFromRows([
      row({ sessionId: 'a', blockType: 'text', textValue: '   ' }),
      row({ sessionId: 'a', blockType: 'thinking', thinkingValue: '' }),
      row({ sessionId: 'a', blockType: 'text', textValue: 'kept' }),
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].entries).toHaveLength(1);
  });
});
