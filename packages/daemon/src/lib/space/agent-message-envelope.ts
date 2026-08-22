export type AgentMessageLevel = 'space-agent' | 'task-agent' | 'node-agent' | 'session-agent';

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

export const REPLY_PROTOCOL =
  'Messaging protocol: if this message requests work or information from you, reply to the sender with the outcome when done — or promptly if you cannot do it. Do not leave the sender waiting.';

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
  if (options.fromAgentName === 'space-agent') return '@coordinator';
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

  if (options.toLevel === 'space-agent') {
    const task = taskLabel(options.taskNumber);
    const taskId = options.taskId ? ` with task_id="${options.taskId}"` : '';
    return (
      `─── Message from ${options.fromAgentName}${task} ───\n\n` +
      `${body}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      `To reply, use: send_message_to_task${taskId}${replyTargetSuffix(options)}${footer}`
    );
  }

  if (options.fromLevel === 'space-agent' || options.fromLevel === 'session-agent') {
    return (
      `─── Message from ${options.fromAgentName} ───\n\n` +
      `${body}${footer}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      `To reply, use: send_message with target "${replyTargetHandle(options)}"`
    );
  }

  if (options.fromLevel === 'node-agent' && options.toLevel === 'node-agent') {
    return (
      `─── Message from ${options.fromAgentName} ───\n\n` +
      `${body}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      `To reply, use: send_message with target "${options.fromAgentName}"${footer}`
    );
  }

  if (options.fromLevel === 'node-agent' && options.toLevel === 'task-agent') {
    return (
      `─── Message from ${options.fromAgentName}${taskLabel(options.taskNumber)} ───\n\n` +
      `${body}${footer}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      `To reply, use: send_message with target "${options.fromAgentName}"`
    );
  }

  if (options.fromLevel === 'task-agent' && options.toLevel === 'node-agent') {
    return (
      `─── Message from task-agent${taskLabel(options.taskNumber)} ───\n\n` +
      `${body}${footer}\n\n` +
      `─── Reply ───\n` +
      protocolLine +
      `To reply, use: send_message with target "task-agent"`
    );
  }

  return `─── Message from ${options.fromAgentName} ───\n\n${body}${footer}`;
}

export function extractReplyToSessionId(message: string): string | null {
  const match = message.match(/<reply-routing replyToSessionId="([^"]+)" \/>\s*$/);
  return match ? match[1] : null;
}
