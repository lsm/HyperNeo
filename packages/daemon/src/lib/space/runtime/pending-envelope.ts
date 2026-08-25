import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository.ts';
import {
  type AgentMessageLevel,
  formatAgentMessage,
  REPLY_PROTOCOL,
} from '../agent-message-envelope.ts';

const AGENT_MESSAGE_ENVELOPE_HEADER = /^─── Message from ([^\n]+) ───\n\n/;
const AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK = `\n\n─── Reply ───\n${REPLY_PROTOCOL}\nTo reply, use: `;
const LEGACY_AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK = '\n\n─── Reply ───\nTo reply, use: ';

export type PendingEnvelopeRow = Pick<
  PendingAgentMessageRecord,
  'sourceAgentName' | 'message' | 'taskId'
>;

export function pendingSourceLevel(sourceAgentName: string): AgentMessageLevel {
  if (sourceAgentName === 'task-agent') return 'task-agent';
  if (sourceAgentName === 'space-agent') return 'space-agent';
  if (sourceAgentName === 'space-member') return 'session-agent';
  return 'node-agent';
}

function expectedEnvelopeSenderNames(sourceAgentName: string): string[] {
  return sourceAgentName === 'space-agent' ? ['space-agent', 'Space Agent'] : [sourceAgentName];
}

export function hasAgentMessageEnvelope(
  message: string,
  sourceAgentName: string,
  toLevel: AgentMessageLevel
): boolean {
  const match = message.match(AGENT_MESSAGE_ENVELOPE_HEADER);
  if (!match) return false;

  const fromLevel = pendingSourceLevel(sourceAgentName);
  const expectedSenders = expectedEnvelopeSenderNames(sourceAgentName);
  const headerSender = match[1];
  if (
    !expectedSenders.some(
      (expectedSender) =>
        headerSender === expectedSender || headerSender.startsWith(`${expectedSender} (task #`)
    )
  ) {
    return false;
  }

  if (fromLevel === 'node-agent' && toLevel === 'node-agent') return true;
  return (
    message.includes(AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK) ||
    message.includes(LEGACY_AGENT_MESSAGE_ENVELOPE_REPLY_BLOCK)
  );
}

export function isHumanPendingSource(sourceAgentName: string): boolean {
  return sourceAgentName === 'human';
}

export function formatPendingRowForNodeAgent(
  row: PendingEnvelopeRow,
  targetAgentName: string
): string {
  if (isHumanPendingSource(row.sourceAgentName)) return `[Message from human]: ${row.message}`;
  if (hasAgentMessageEnvelope(row.message, row.sourceAgentName, 'node-agent')) return row.message;
  return formatAgentMessage({
    fromLevel: pendingSourceLevel(row.sourceAgentName),
    fromAgentName: row.sourceAgentName,
    toLevel: 'node-agent',
    body: row.message,
    taskId: row.taskId,
    nodeId: targetAgentName,
  });
}

export function formatPendingRowForSpaceAgent(row: PendingEnvelopeRow): string {
  if (hasAgentMessageEnvelope(row.message, row.sourceAgentName, 'space-agent')) return row.message;
  return formatAgentMessage({
    fromLevel: pendingSourceLevel(row.sourceAgentName),
    fromAgentName: row.sourceAgentName,
    toLevel: 'space-agent',
    body: row.message,
    taskId: row.taskId,
  });
}
