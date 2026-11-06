import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readTurnUrls } from '../../storage/hyperneo-turn-facts-read.ts';
import {
  assistantText,
  claudeInputText,
  claudeNativeFingerprint,
  claudeTurnEnded,
  type ClaudeTranscriptEntry,
} from './claude-desktop-adapter.ts';
import type { WorkTurnFact } from './types.ts';

const TURNS_PER_READ = 10;

type Row = ClaudeTranscriptEntry & {
  isCompactSummary?: unknown;
  operation?: unknown;
  reason?: unknown;
  commandUuid?: unknown;
  message?: { id?: unknown; content?: unknown; stop_reason?: unknown };
};
type End = { row: Row; offset: number; interrupted?: boolean };
type Open = { inputAt: number | null; firstAt: number | null; complete: boolean };
type Turn = Open & { inputs: Set<string>; urls: Set<string>; finalUrls: Set<string> };

const openTurn = (): Turn => ({
  inputAt: null,
  firstAt: null,
  complete: true,
  inputs: new Set(),
  urls: new Set(),
  finalUrls: new Set(),
});

const rowTime = (row: Row) => (typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN);

const INTERRUPTED = '[Request interrupted by user';

function inputIds(row: Row): string[] {
  if (row.type === 'queue-operation')
    return row.operation === 'remove' &&
      row.reason === 'absorbed_mid_turn' &&
      typeof row.commandUuid === 'string'
      ? [row.commandUuid]
      : [];
  const text = claudeInputText(row);
  if (text === null) return [];
  const queued = (row.attachment as { source_uuid?: unknown } | undefined)?.source_uuid;
  const id = queued ?? row.uuid;
  const native = claudeNativeFingerprint(text);
  return [
    ...(typeof id === 'string' ? [id] : []),
    ...(native ? [`desktop-pending:${native}`] : []),
  ];
}

const isToolOutput = (row: Row) =>
  row.type === 'user' &&
  Array.isArray(row.message?.content) &&
  row.message.content.some((part: { type?: unknown }) => part?.type === 'tool_result');

function parseRow(line: string): Row | null {
  try {
    const row = JSON.parse(line) as Row | null;
    return row && typeof row === 'object' ? row : null;
  } catch {
    return null;
  }
}

function addRow(turn: Turn, row: Row) {
  const at = rowTime(row);
  if (Number.isFinite(at)) turn.firstAt ??= at;
  for (const id of inputIds(row)) {
    turn.inputs.add(id);
    if (Number.isFinite(at)) turn.inputAt ??= at;
  }
  if (isToolOutput(row))
    for (const url of readTurnUrls([JSON.stringify(row.message?.content)])) turn.urls.add(url);
}

function finishTurn(turn: Turn, end: End): WorkTurnFact {
  const endedAt = rowTime(end.row);
  return {
    id: String(end.row.uuid),
    startedAt: turn.inputAt ?? turn.firstAt ?? endedAt,
    endedAt,
    ended: end.interrupted ? 'interrupted' : String(end.row.message?.stop_reason),
    inputs: [...turn.inputs],
    urls: [...turn.urls],
    finalUrls: [...turn.finalUrls],
    complete: turn.complete,
    cursor: JSON.stringify({ seq: end.offset, consumed: 0, at: endedAt }),
  };
}

const sameMessage = (end: End, row: Row | null) =>
  row?.type === 'assistant' &&
  typeof row.message?.id === 'string' &&
  row.message.id === end.row.message?.id;

export async function readClaudeTurnFacts(
  path: string,
  cursor?: string,
  limit = TURNS_PER_READ
): Promise<WorkTurnFact[]> {
  const start: number = cursor ? JSON.parse(cursor).seq : 0;
  const stream = createReadStream(path, { start });
  const facts: WorkTurnFact[] = [];
  let offset = start;
  let turn = openTurn();
  let end: End | null = null;
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      offset += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      const row = parseRow(line);
      if (row?.isSidechain === true || row?.isCompactSummary === true) continue;
      if (end && !sameMessage(end, row)) {
        facts.push(finishTurn(turn, end));
        turn = openTurn();
        end = null;
        if (facts.length === limit) break;
      }
      if (!row) {
        turn.complete = false;
        continue;
      }
      if (claudeInputText(row)?.startsWith(INTERRUPTED)) {
        end = { row, offset, interrupted: true };
        continue;
      }
      addRow(turn, row);
      if (row.type !== 'assistant' || !claudeTurnEnded(row) || !Number.isFinite(rowTime(row)))
        continue;
      for (const url of readTurnUrls([assistantText(line) ?? ''])) {
        turn.urls.add(url);
        turn.finalUrls.add(url);
      }
      end = { row, offset };
    }
    if (end) facts.push(finishTurn(turn, end));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    stream.destroy();
  }
  return facts;
}
