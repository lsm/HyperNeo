import type { SessionProgress, SessionProgressItem, SessionProgressStatus } from '@hyperneo/shared';

interface ToolUse {
  id?: string;
  name: string;
  input?: unknown;
}

interface ToolResult {
  toolUseId: string;
  content: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asStatus(value: unknown): SessionProgressStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function fromTodoWrite(input: unknown): SessionProgressItem[] | null {
  if (!isRecord(input) || !Array.isArray(input.todos)) return null;
  const items: SessionProgressItem[] = [];
  input.todos.forEach((todo, index) => {
    if (!isRecord(todo)) return;
    const content = text(todo.content);
    if (!content) return;
    items.push({
      id: `todo:${index}`,
      content,
      status: asStatus(todo.status),
      ...(text(todo.activeForm) ? { activeForm: text(todo.activeForm) } : {}),
    });
  });
  return items;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

function taskIdFromResult(content: unknown): string | null {
  const raw = resultText(content).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const id = isRecord(parsed) && isRecord(parsed.task) ? parsed.task.id : undefined;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  } catch {}
  const match = raw.match(/\btask\s*#?\s*(\d+)/i) ?? raw.match(/\bid[:\s]+"?(\w+)/i);
  return match ? match[1] : null;
}

function applyToolUse(
  current: SessionProgress | undefined,
  tool: ToolUse
): SessionProgressItem[] | null {
  const items = current?.items ?? [];
  const input = tool.input;
  if (tool.name === 'TodoWrite') return fromTodoWrite(input);
  if (!isRecord(input)) return null;
  if (tool.name === 'TaskCreate') {
    const subject = text(input.subject);
    if (!subject || !tool.id) return null;
    const base = current?.source === 'task' ? items : [];
    const activeForm = text(input.activeForm);
    return [
      ...base,
      {
        id: `task:pending:${tool.id}`,
        content: subject,
        status: 'pending',
        ...(activeForm ? { activeForm } : {}),
      },
    ];
  }
  if (tool.name === 'TaskUpdate') {
    if (current?.source !== 'task') return null;
    const id = `task:${String(input.taskId)}`;
    if (!items.some((item) => item.id === id)) return null;
    if (input.status === 'deleted') return items.filter((item) => item.id !== id);
    const subject = text(input.subject);
    const activeForm = text(input.activeForm);
    return items.map((item) =>
      item.id !== id
        ? item
        : {
            ...item,
            ...(subject ? { content: subject } : {}),
            ...(input.status !== undefined ? { status: asStatus(input.status) } : {}),
            ...(activeForm ? { activeForm } : {}),
          }
    );
  }
  return null;
}

export function applyProgressToolUses(
  current: SessionProgress | undefined,
  toolUses: readonly ToolUse[],
  now: () => string = () => new Date().toISOString()
): SessionProgress | null {
  let progress = current;
  let changed = false;
  for (const tool of toolUses) {
    const items = applyToolUse(progress, tool);
    if (!items) continue;
    const source = tool.name === 'TodoWrite' ? 'todo' : 'task';
    const pending =
      source === 'task' && progress?.source === 'task' ? { ...progress.pendingTaskIds } : {};
    if (tool.name === 'TaskCreate' && tool.id) pending[tool.id] = `task:pending:${tool.id}`;
    progress = {
      source,
      items,
      updatedAt: now(),
      ...(Object.keys(pending).length > 0 ? { pendingTaskIds: pending } : {}),
    };
    changed = true;
  }
  return changed && progress ? progress : null;
}

export function applyProgressToolResults(
  current: SessionProgress | undefined,
  results: readonly ToolResult[],
  now: () => string = () => new Date().toISOString()
): SessionProgress | null {
  if (!current?.pendingTaskIds) return null;
  let items = current.items;
  const pending = { ...current.pendingTaskIds };
  let changed = false;
  for (const result of results) {
    const provisional = pending[result.toolUseId];
    if (!provisional) continue;
    const taskId = taskIdFromResult(result.content);
    delete pending[result.toolUseId];
    changed = true;
    if (!taskId) continue;
    const real = `task:${taskId}`;
    items = items.map((item) => (item.id === provisional ? { ...item, id: real } : item));
  }
  if (!changed) return null;
  return {
    ...current,
    items,
    updatedAt: now(),
    ...(Object.keys(pending).length > 0 ? { pendingTaskIds: pending } : {}),
    ...(Object.keys(pending).length === 0 ? { pendingTaskIds: undefined } : {}),
  };
}
