import { open } from 'node:fs/promises';
import { readTurnUrls } from '../../storage/hyperneo-turn-facts-read.ts';
import { codexUserInput, parseLine } from './codex-rollout-lines.ts';
import type { WorkTurnFact } from './types.ts';
import { workEntryTime } from './work-messages.ts';

const TURNS_PER_READ = 10;
const READ_BYTES = 1024 * 1024;
const TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output']);

export type CodexOpenTurn = {
  id: string;
  startedAt: number;
  lastAt: number;
  inputs: string[];
  urls: Set<string>;
  complete: boolean;
};

type Folded = { turn: CodexOpenTurn | null; fact?: WorkTurnFact };

const textUrls = (text: unknown) =>
  text ? readTurnUrls([typeof text === 'string' ? text : JSON.stringify(text)]) : [];

const withUrls = (turn: CodexOpenTurn, text: unknown): CodexOpenTurn => ({
  ...turn,
  urls: new Set([...turn.urls, ...textUrls(text)]),
});

const turnFact = (
  turn: CodexOpenTurn,
  ended: string,
  endedAt: number,
  complete: boolean,
  offset: number,
  finalUrls: string[] = []
): WorkTurnFact => ({
  id: turn.id,
  startedAt: turn.startedAt,
  endedAt,
  ended,
  inputs: turn.inputs,
  urls: [...turn.urls],
  finalUrls,
  complete,
  cursor: JSON.stringify({ seq: offset, consumed: 0 }),
});

export function foldCodexTurnLine(
  open: CodexOpenTurn | null,
  line: string,
  lineStart: number,
  lineEnd: number
): Folded {
  if (!line.trim()) return { turn: open };
  const entry = parseLine(line);
  if (!entry) return { turn: open && { ...open, complete: false } };
  const payload = entry.payload ?? {};
  const at = workEntryTime(entry.timestamp);
  const turn = open && { ...open, lastAt: at ?? open.lastAt };
  if (entry.type === 'event_msg' && payload.type === 'task_started' && at !== undefined) {
    const id = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : `${at}`;
    const next = { id, startedAt: at, lastAt: at, inputs: [], urls: new Set<string>() };
    return {
      turn: { ...next, complete: true },
      ...(open ? { fact: turnFact(open, 'unknown', open.lastAt, false, lineStart) } : {}),
    };
  }
  if (!turn) return { turn: null };
  if (entry.type === 'event_msg' && payload.type === 'task_complete') {
    const final = withUrls(turn, payload.last_agent_message);
    const ended = payload.error ? 'errored' : 'completed';
    const finalUrls = textUrls(payload.last_agent_message);
    return {
      turn: null,
      fact: turnFact(final, ended, final.lastAt, final.complete, lineEnd, finalUrls),
    };
  }
  if (entry.type === 'event_msg' && payload.type === 'turn_aborted')
    return { turn: null, fact: turnFact(turn, 'aborted', turn.lastAt, turn.complete, lineEnd) };
  if (entry.type !== 'response_item') return { turn };
  if (TOOL_OUTPUTS.has(String(payload.type))) return { turn: withUrls(turn, payload.output) };
  const input = codexUserInput(entry);
  return { turn: input ? { ...turn, inputs: [...turn.inputs, input.id] } : turn };
}

export async function readCodexTurnFacts(
  path: string,
  cursor?: string,
  limit = TURNS_PER_READ
): Promise<WorkTurnFact[]> {
  const handle = await open(path, 'r');
  const facts: WorkTurnFact[] = [];
  try {
    const chunk = Buffer.allocUnsafe(READ_BYTES);
    let lineStart = cursor ? (JSON.parse(cursor) as { seq: number }).seq : 0;
    let position = lineStart;
    let pending = Buffer.alloc(0);
    let turn: CodexOpenTurn | null = null;
    while (facts.length < limit) {
      const { bytesRead } = await handle.read(chunk, 0, READ_BYTES, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let from = 0;
      for (
        let newline = pending.indexOf(10);
        newline >= 0 && facts.length < limit;
        newline = pending.indexOf(10, from)
      ) {
        const lineEnd = lineStart + newline + 1 - from;
        const line = pending.toString('utf8', from, newline);
        const folded: Folded = foldCodexTurnLine(turn, line, lineStart, lineEnd);
        turn = folded.turn;
        if (folded.fact) facts.push(folded.fact);
        from = newline + 1;
        lineStart = lineEnd;
      }
      pending = pending.subarray(from);
    }
    return facts;
  } finally {
    await handle.close();
  }
}
