import {
  isSDKResultMessage,
  isSDKUserMessage,
  isSDKUserMessageReplay,
} from '@hyperneo/shared/sdk/type-guards';
import type { ParsedThreadRow } from './space-task-thread-events';

export interface AgentTurnBlock {
  id: string;
  agentLabel: string;
  rows: ParsedThreadRow[];
  isTerminal: boolean;
}

export function normalizeAgentKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowIsTerminal(row: ParsedThreadRow): boolean {
  return row.message !== null && isSDKResultMessage(row.message);
}

export function buildAgentTurns(rows: ParsedThreadRow[]): AgentTurnBlock[] {
  const blocks: AgentTurnBlock[] = [];
  let previousWasTerminal = false;

  for (const row of rows) {
    const last = blocks[blocks.length - 1];
    const isSameAgent =
      last !== undefined && normalizeAgentKey(last.agentLabel) === normalizeAgentKey(row.label);
    const terminal = rowIsTerminal(row);

    if (isSameAgent && !previousWasTerminal) {
      last.rows.push(row);
      if (terminal) last.isTerminal = true;
    } else {
      blocks.push({
        id: String(row.id),
        agentLabel: row.label,
        rows: [row],
        isTerminal: terminal,
      });
    }
    previousWasTerminal = terminal;
  }

  return blocks;
}

export function isUserRow(row: ParsedThreadRow): boolean {
  if (!row.message) return false;
  return isSDKUserMessage(row.message) || isSDKUserMessageReplay(row.message);
}
