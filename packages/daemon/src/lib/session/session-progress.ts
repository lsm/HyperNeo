import type { SessionProgress, SessionProgressItem, SessionProgressStatus } from '@hyperneo/shared';

interface ToolUse {
  name: string;
  input?: unknown;
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

function nextTaskId(items: SessionProgressItem[]): string {
  const max = items.reduce((acc, item) => {
    const n = item.id.startsWith('task:') ? Number(item.id.slice(5)) : Number.NaN;
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return `task:${max + 1}`;
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
    if (!subject) return null;
    const base = current?.source === 'task' ? items : [];
    const activeForm = text(input.activeForm);
    return [
      ...base,
      {
        id: nextTaskId(base),
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
    progress = { source: tool.name === 'TodoWrite' ? 'todo' : 'task', items, updatedAt: now() };
    changed = true;
  }
  return changed && progress ? progress : null;
}
