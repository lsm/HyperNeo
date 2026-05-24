/**
 * Space task thread — turn grouping.
 *
 * Splits a flat list of `ParsedThreadRow`s into "agent-turn blocks": one block
 * per query/response cycle. A new block starts when (a) the agent label
 * changes or (b) the previous row was an SDK `result` message (i.e. an exec
 * cycle just closed — the next row is the start of a new turn).
 *
 * The minimal thread feed is the only renderer; it consumes these blocks to
 * produce one row per agent turn. Earlier "compact" mode lived alongside
 * minimal and had its own block-builder + visibility logic; both are gone now,
 * so this module is intentionally small — just the grouping primitives the
 * feed needs.
 */
import {
  isSDKResultMessage,
  isSDKUserMessage,
  isSDKUserMessageReplay,
} from '@neokai/shared/sdk/type-guards';
import type { ParsedThreadRow } from './space-task-thread-events';

/**
 * One agent-turn block — a contiguous run of rows from a single agent that
 * corresponds to one exec cycle (init → tool uses + assistant text → result).
 */
export interface AgentTurnBlock {
  /** Stable id derived from the first row in the block. */
  id: string;
  /** Agent label, e.g. "Task Agent", "Coder Agent". */
  agentLabel: string;
  /** Rows in the block, in chronological order. */
  rows: ParsedThreadRow[];
  /**
   * True when the block contains an SDK result message. The minimal feed
   * uses this to decide whether the trailing block is "active" (eligible
   * for the live rail) or already closed.
   */
  isTerminal: boolean;
}

/**
 * Lowercase + collapse-whitespace agent label normaliser. Exported so callers
 * that match block agent labels against external label sources (e.g. activity
 * members emitted by the daemon, which run their `role` through a separate
 * title-casing helper before reaching the renderer) can compare against the
 * same canonical form `buildAgentTurns` uses internally to detect agent
 * boundaries.
 */
export function normalizeAgentKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowIsTerminal(row: ParsedThreadRow): boolean {
  return row.message !== null && isSDKResultMessage(row.message);
}

/**
 * Group rows into agent-turn blocks: split on agent change AND on result
 * messages. Each block represents exactly one query/response cycle bounded by
 * (start) → (next result|success / result|error).
 *
 * Splitting on the result row (rather than starting a new block when the NEXT
 * row arrives) keeps the result row at the tail of its own turn — convenient
 * for renderers that read closing text from `result.result`.
 */
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

/**
 * Returns `true` when the row is a user-type SDK message — either a real human
 * input or a synthetic agent→agent handoff. The minimal feed splits user-type
 * rows out of their containing block as standalone "message turns".
 */
export function isUserRow(row: ParsedThreadRow): boolean {
  if (!row.message) return false;
  return isSDKUserMessage(row.message) || isSDKUserMessageReplay(row.message);
}
