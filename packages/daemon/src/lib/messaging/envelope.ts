import {
  fillPrompt,
  MESSAGING_REPLY_PROTOCOL,
  MESSAGING_REPLY_TO_TARGET,
  MESSAGING_REPLY_TO_TASK,
} from '@hyperneo/prompts';
export type AgentMessageLevel =
  | 'long-horizon-agent'
  | 'task-agent'
  | 'node-agent'
  | 'session-agent';

export interface FormatAgentMessageOptions {
  fromLevel: AgentMessageLevel;
  fromAgentName: string;
  toLevel: AgentMessageLevel;
  body: string;
  taskId?: string | null;
  taskNumber?: number | null;
  nodeId?: string | null;
  replyTargetHandle?: string | null;
  replyToSessionId?: string | null;
}

export const REPLY_PROTOCOL = MESSAGING_REPLY_PROTOCOL;

function taskLabel(taskNumber?: number | null): string {
  return typeof taskNumber === 'number' ? ` (task #${taskNumber})` : '';
}

function replyTargetSuffix(options: FormatAgentMessageOptions): string {
  if (options.fromLevel !== 'node-agent') return '';
  const target = options.nodeId ?? options.fromAgentName;
  return ` and target node "${target}"`;
}

function replyTargetHandle(options: FormatAgentMessageOptions): string {
  if (options.replyTargetHandle) return options.replyTargetHandle;
  return `@${options.fromAgentName}`;
}

function replyRoutingFooter(options: FormatAgentMessageOptions): string {
  if (!options.replyToSessionId) return '';
  return `\n\n<reply-routing replyToSessionId="${options.replyToSessionId}" />`;
}

export function formatAgentMessage(options: FormatAgentMessageOptions): string {
  const body = options.body;
  const footer = replyRoutingFooter(options);
  const protocolLine = `${REPLY_PROTOCOL}\n`;

  if (options.toLevel === 'long-horizon-agent') {
    const task = taskLabel(options.taskNumber);
    const taskId = options.taskId ? ` with task_id="${options.taskId}"` : '';
    return (
      `─── Message from ${options.fromAgentName}${task} ───\n\n` +
      `${body}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      fillPrompt(MESSAGING_REPLY_TO_TASK, { task_id: taskId, target: replyTargetSuffix(options) }) +
      footer
    );
  }

  if (options.fromLevel === 'long-horizon-agent' || options.fromLevel === 'session-agent') {
    return (
      `─── Message from ${options.fromAgentName} ───\n\n` +
      `${body}${footer}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      fillPrompt(MESSAGING_REPLY_TO_TARGET, { target: replyTargetHandle(options) })
    );
  }

  if (options.fromLevel === 'node-agent' && options.toLevel === 'node-agent') {
    return (
      `─── Message from ${options.fromAgentName} ───\n\n` +
      `${body}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      fillPrompt(MESSAGING_REPLY_TO_TARGET, { target: options.fromAgentName }) +
      footer
    );
  }

  if (options.fromLevel === 'node-agent' && options.toLevel === 'task-agent') {
    return (
      `─── Message from ${options.fromAgentName}${taskLabel(options.taskNumber)} ───\n\n` +
      `${body}${footer}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      fillPrompt(MESSAGING_REPLY_TO_TARGET, { target: options.fromAgentName })
    );
  }

  if (options.fromLevel === 'task-agent' && options.toLevel === 'node-agent') {
    return (
      `─── Message from task-agent${taskLabel(options.taskNumber)} ───\n\n` +
      `${body}${footer}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      fillPrompt(MESSAGING_REPLY_TO_TARGET, { target: 'task-agent' })
    );
  }

  return `─── Message from ${options.fromAgentName} ───\n\n${body}${footer}`;
}

export function extractReplyToSessionId(message: string): string | null {
  const match = message.match(/<reply-routing replyToSessionId="([^"]+)" \/>\s*$/);
  return match ? match[1] : null;
}
