import { useMemo } from 'preact/hooks';
import type { ChatMessage } from '@hyperneo/shared';

export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'killed';

export interface BackgroundTask {
  id: string;
  toolUseId?: string;
  label: string;
  status: BackgroundTaskStatus;
  backgrounded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asBackgroundTaskStatus(value: unknown): BackgroundTaskStatus | null {
  if (
    value === 'pending' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'killed'
  ) {
    return value;
  }
  return null;
}

function buildBackgroundTaskMap(
  messages: ChatMessage[],
  toolInputsMap: Map<string, unknown>
): Map<string, BackgroundTask> {
  const tasks = new Map<string, BackgroundTask>();

  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record.type !== 'system') continue;

    const taskId = getString(record, 'task_id');
    if (!taskId) continue;

    if (record.subtype === 'task_started') {
      const toolUseId = getString(record, 'tool_use_id');
      const toolInput = toolUseId ? toolInputsMap.get(toolUseId) : undefined;
      const inputLabel = isRecord(toolInput)
        ? getString(toolInput, 'description') || getString(toolInput, 'command')
        : undefined;
      tasks.set(taskId, {
        id: taskId,
        toolUseId,
        label: inputLabel || getString(record, 'description') || 'Background task',
        status: 'running',
        backgrounded: false,
      });
      continue;
    }

    const existing = tasks.get(taskId);
    if (!existing) continue;

    if (record.subtype === 'task_updated' && isRecord(record.patch)) {
      const status = asBackgroundTaskStatus(getString(record.patch, 'status'));
      if (status) {
        existing.status = status;
      }
      if (typeof record.patch.is_backgrounded === 'boolean') {
        existing.backgrounded = record.patch.is_backgrounded;
      }
      const description = getString(record.patch, 'description');
      if (description) existing.label = description;
      continue;
    }

    if (record.subtype === 'task_notification') {
      const status = getString(record, 'status');
      if (status === 'completed' || status === 'failed') existing.status = status;
      if (status === 'stopped') existing.status = 'killed';
    }
  }

  return tasks;
}

export function extractBackgroundTasks(
  messages: ChatMessage[],
  toolInputsMap: Map<string, unknown>
): BackgroundTask[] {
  return [...buildBackgroundTaskMap(messages, toolInputsMap).values()]
    .filter((task) => task.backgrounded || task.status === 'running' || task.status === 'paused')
    .slice(-4);
}

export function extractRunningToolUseIds(messages: ChatMessage[]): Set<string> {
  const runningToolUseIds = new Set<string>();

  for (const task of buildBackgroundTaskMap(messages, new Map()).values()) {
    if (
      task.toolUseId &&
      (task.status === 'pending' || task.status === 'running' || task.status === 'paused')
    ) {
      runningToolUseIds.add(task.toolUseId);
    }
  }

  return runningToolUseIds;
}

export function useRunningToolUseIds(messages: ChatMessage[]): Set<string> {
  return useMemo(() => extractRunningToolUseIds(messages), [messages]);
}
