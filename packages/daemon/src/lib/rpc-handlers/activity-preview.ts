const ACTIVITY_PREVIEW_MAX_LEN = 200;

function activityOneLine(value: string, max = ACTIVITY_PREVIEW_MAX_LEN): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function activityStringProp(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function activityNumberProp(input: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number(input[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function activityPathBase(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function activityPreviewFromTodoInput(input: Record<string, unknown>): string {
  const todos = input.todos;
  if (!Array.isArray(todos)) return 'Update todos';
  const todoItems = todos
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const content = activityStringProp(item, 'content');
      const activeForm = activityStringProp(item, 'activeForm');
      const status = activityStringProp(item, 'status');
      return { content, activeForm, status };
    });
  const running = todoItems.find((item) => item.status === 'in_progress');
  if (running) {
    return activityOneLine(`Running: ${running.activeForm || running.content || 'todo item'}`);
  }
  const completed = [...todoItems].reverse().find((item) => item.status === 'completed');
  if (completed?.content) return activityOneLine(`Marked done: ${completed.content}`);
  const pending = todoItems.find((item) => item.status === 'pending');
  if (pending?.content) return activityOneLine(`Added task: ${pending.content}`);
  const count = todoItems.length;
  return count ? `${count} todo${count !== 1 ? 's' : ''}` : 'Update todos';
}

function activityPreviewFromQuestionInput(input: Record<string, unknown>): string {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return 'Ask user';
  const firstQuestion = questions.find(
    (question): question is Record<string, unknown> => !!question && typeof question === 'object'
  );
  const text = firstQuestion ? activityStringProp(firstQuestion, 'question') : '';
  if (!text) return `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
  const suffix = questions.length > 1 ? ` (+${questions.length - 1})` : '';
  return `${activityOneLine(text, 60)}${suffix}`;
}

function activityPreviewFromToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName.startsWith('mcp__')) {
    return '';
  }
  switch (toolName) {
    case 'Bash': {
      const description = activityStringProp(input, 'description');
      if (description) return activityOneLine(description);
      return activityOneLine(activityStringProp(input, 'command'));
    }
    case 'Write':
    case 'Edit': {
      const filePath = activityStringProp(input, 'file_path');
      return filePath ? activityOneLine(activityPathBase(filePath)) : '';
    }
    case 'MultiEdit': {
      const filePath = activityStringProp(input, 'file_path');
      return filePath ? activityOneLine(activityPathBase(filePath)) : '';
    }
    case 'Read': {
      const filePath = activityStringProp(input, 'file_path');
      return filePath ? activityOneLine(activityPathBase(filePath)) : '';
    }
    case 'NotebookEdit': {
      const notebookPath = activityStringProp(input, 'notebook_path');
      return notebookPath ? activityOneLine(activityPathBase(notebookPath)) : '';
    }
    case 'Glob':
    case 'Grep':
      return activityOneLine(activityStringProp(input, 'pattern'), 50);
    case 'WebFetch':
      return activityOneLine(activityStringProp(input, 'url'), 50);
    case 'WebSearch':
      return activityOneLine(activityStringProp(input, 'query'), 50);
    case 'Task':
      return activityOneLine(activityStringProp(input, 'description') || 'Task execution');
    case 'Agent':
      return activityOneLine(activityStringProp(input, 'description') || 'Agent execution');
    case 'TaskOutput':
      return activityOneLine(activityStringProp(input, 'task_id') || 'Task output');
    case 'TaskStop':
      return activityOneLine(
        activityStringProp(input, 'task_id') || activityStringProp(input, 'shell_id') || 'Stop task'
      );
    case 'BashOutput': {
      const bashId = activityStringProp(input, 'bash_id');
      return `Shell: ${bashId.slice(0, 8) || 'unknown'}`;
    }
    case 'KillShell': {
      const shellId = activityStringProp(input, 'shell_id');
      return `Shell: ${shellId.slice(0, 8) || 'unknown'}`;
    }
    case 'TodoWrite':
      return activityPreviewFromTodoInput(input);
    case 'ListMcpResourcesTool':
      return activityOneLine(activityStringProp(input, 'server') || 'All servers');
    case 'ReadMcpResourceTool':
      return activityOneLine(activityStringProp(input, 'uri'), 50);
    case 'AskUserQuestion':
      return activityPreviewFromQuestionInput(input);
    case 'EnterPlanMode':
      return 'Entering plan mode';
    case 'ExitPlanMode':
      return 'Exiting plan mode';
    case 'TimeMachine':
      return activityOneLine(activityStringProp(input, 'message_prefix'), 40);
    default: {
      const keys = Object.keys(input);
      if (keys.length === 0) return '';
      const firstKey = keys[0];
      const firstVal = input[firstKey];
      if (typeof firstVal === 'string') return activityOneLine(firstVal, 40);
      return `${firstKey}: …`;
    }
  }
}

export function buildActiveTurnSummariesFromRows(
  rows: Record<string, unknown>[]
): Array<{ sessionId: string; turnIndex: number; entries: Record<string, unknown>[] }> {
  const bySession = new Map<
    string,
    { sessionId: string; turnIndex: number; entries: Record<string, unknown>[] }
  >();

  for (const row of rows) {
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : null;
    if (!sessionId) continue;
    const turnIndex = Number(row.turnIndex ?? 0);
    const ts = Number(row.ts ?? 0);
    const uuid = typeof row.uuid === 'string' ? row.uuid : '';
    const blockType = typeof row.blockType === 'string' ? row.blockType : '';

    let entry: Record<string, unknown> | null = null;
    if (blockType === 'tool_use') {
      const toolName = typeof row.toolName === 'string' ? row.toolName : '';
      const rawInput = row.toolInput;
      let parsedInput: Record<string, unknown> = {};
      if (typeof rawInput === 'string') {
        try {
          const maybe = JSON.parse(rawInput);
          if (maybe && typeof maybe === 'object') {
            parsedInput = maybe as Record<string, unknown>;
          }
        } catch {
          // Leave parsedInput empty — preview falls through to `tool_name: …`.
        }
      } else if (rawInput && typeof rawInput === 'object') {
        parsedInput = rawInput as Record<string, unknown>;
      }
      const toolUseId = typeof row.toolUseId === 'string' ? row.toolUseId : undefined;
      entry = {
        kind: 'tool_use',
        toolName,
        preview: activityPreviewFromToolInput(toolName, parsedInput),
        ts,
        uuid,
        ...(toolUseId ? { toolUseId } : {}),
      };
    } else if (blockType === 'text') {
      const text = typeof row.textValue === 'string' ? row.textValue : '';
      if (text.trim().length === 0) continue;
      entry = { kind: 'text', text: activityOneLine(text), ts, uuid };
    } else if (blockType === 'thinking') {
      const thinking = typeof row.thinkingValue === 'string' ? row.thinkingValue : '';
      if (thinking.trim().length === 0) continue;
      entry = { kind: 'thinking', preview: thinking.trim(), ts, uuid };
    } else if (blockType === '__user_message') {
      const text = typeof row.textValue === 'string' ? row.textValue : '';
      entry = { kind: 'user_message', text: activityOneLine(text), ts, uuid };
    } else if (blockType === '__user_replay') {
      const text = typeof row.textValue === 'string' ? row.textValue : '';
      entry = { kind: 'agent_handoff', text: activityOneLine(text), ts, uuid };
    } else if (blockType === '__hook') {
      const hookName = typeof row.toolName === 'string' ? row.toolName : '';
      const hookEvent = typeof row.hookEvent === 'string' ? row.hookEvent : '';
      const rawStatus = typeof row.hookStatus === 'string' ? row.hookStatus : 'running';
      const status: 'running' | 'completed' | 'failed' =
        rawStatus === 'completed' || rawStatus === 'failed' ? rawStatus : 'running';
      const stdoutSummary = typeof row.textValue === 'string' ? row.textValue.trim() : '';
      entry = {
        kind: 'hook',
        hookName,
        hookEvent,
        status,
        ts,
        uuid,
        ...(stdoutSummary ? { summary: activityOneLine(stdoutSummary) } : {}),
      };
    } else if (blockType === '__api_retry') {
      entry = {
        kind: 'api_retry',
        attempt: activityNumberProp(row, 'attempt', 1),
        maxRetries: activityNumberProp(row, 'maxRetries'),
        retryDelayMs: activityNumberProp(row, 'retryDelayMs'),
        errorStatus: row.errorStatus === null ? null : activityNumberProp(row, 'errorStatus'),
        ts,
        uuid,
      };
    }
    if (!entry) continue;

    let summary = bySession.get(sessionId);
    if (!summary) {
      summary = { sessionId, turnIndex, entries: [] };
      bySession.set(sessionId, summary);
    }
    summary.entries.push(entry);
  }

  return Array.from(bySession.values());
}

function mapActiveTurnEntryRow(row: Record<string, unknown>): Record<string, unknown> {
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
  const turnIndex = Number(row.turnIndex ?? 0);
  const ts = Number(row.ts ?? 0);
  const uuid = typeof row.uuid === 'string' ? row.uuid : '';
  const blockType = typeof row.blockType === 'string' ? row.blockType : '';
  const rowId = typeof row.rowId === 'string' || typeof row.rowId === 'number' ? row.rowId : '';
  const blockIdx = Number(row.blockIdx ?? -1);
  const rawId = row.id;
  const id = typeof rawId === 'string' ? rawId : `${sessionId}:${turnIndex}:${rowId}:${blockIdx}`;

  let entry: Record<string, unknown> | null = null;
  if (blockType === 'tool_use') {
    const toolName = typeof row.toolName === 'string' ? row.toolName : '';
    const rawInput = row.toolInput;
    let parsedInput: Record<string, unknown> = {};
    if (typeof rawInput === 'string') {
      try {
        const maybe = JSON.parse(rawInput);
        if (maybe && typeof maybe === 'object') parsedInput = maybe as Record<string, unknown>;
      } catch {
        parsedInput = {};
      }
    } else if (rawInput && typeof rawInput === 'object') {
      parsedInput = rawInput as Record<string, unknown>;
    }
    const toolUseId = typeof row.toolUseId === 'string' ? row.toolUseId : undefined;
    entry = {
      kind: 'tool_use',
      toolName,
      preview: activityPreviewFromToolInput(toolName, parsedInput),
      ts,
      uuid,
      ...(toolUseId ? { toolUseId } : {}),
    };
  } else if (blockType === 'text') {
    const text = typeof row.textValue === 'string' ? row.textValue : '';
    if (text.trim().length > 0) entry = { kind: 'text', text: activityOneLine(text), ts, uuid };
  } else if (blockType === 'thinking') {
    const thinking = typeof row.thinkingValue === 'string' ? row.thinkingValue : '';
    if (thinking.trim().length > 0) {
      entry = { kind: 'thinking', preview: thinking.trim(), ts, uuid };
    }
  } else if (blockType === '__user_message') {
    const text = typeof row.textValue === 'string' ? row.textValue : '';
    entry = { kind: 'user_message', text: activityOneLine(text), ts, uuid };
  } else if (blockType === '__user_replay') {
    const text = typeof row.textValue === 'string' ? row.textValue : '';
    entry = { kind: 'agent_handoff', text: activityOneLine(text), ts, uuid };
  } else if (blockType === '__hook') {
    const hookName = typeof row.toolName === 'string' ? row.toolName : '';
    const hookEvent = typeof row.hookEvent === 'string' ? row.hookEvent : '';
    const rawStatus = typeof row.hookStatus === 'string' ? row.hookStatus : 'running';
    const status: 'running' | 'completed' | 'failed' =
      rawStatus === 'completed' || rawStatus === 'failed' ? rawStatus : 'running';
    const stdoutSummary = typeof row.textValue === 'string' ? row.textValue.trim() : '';
    entry = {
      kind: 'hook',
      hookName,
      hookEvent,
      status,
      ts,
      uuid,
      ...(stdoutSummary ? { summary: activityOneLine(stdoutSummary) } : {}),
    };
  } else if (blockType === '__api_retry') {
    entry = {
      kind: 'api_retry',
      attempt: activityNumberProp(row, 'attempt', 1),
      maxRetries: activityNumberProp(row, 'maxRetries'),
      retryDelayMs: activityNumberProp(row, 'retryDelayMs'),
      errorStatus: row.errorStatus === null ? null : activityNumberProp(row, 'errorStatus'),
      ts,
      uuid,
    };
  }

  return {
    id,
    sessionId,
    turnIndex,
    ts,
    entry,
  };
}

export { mapActiveTurnEntryRow };
