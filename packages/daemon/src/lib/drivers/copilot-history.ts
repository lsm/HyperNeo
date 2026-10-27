import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import type { WorkTurnPage } from '../../storage/work-turn-page.ts';
import type { WorkTurn } from '../../storage/work-turns.ts';

export function createCopilotInputReader() {
  const misses = new Map<string, { stamp: string; markers: Set<string> }>();
  return async (file: string, sessionId: string, marker: string): Promise<WorkTurn | null> => {
    let stamp: string;
    try {
      const info = lstatSync(file);
      stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch {
      return null;
    }
    const key = JSON.stringify([file, sessionId]);
    const previous = misses.get(key);
    if (previous?.stamp === stamp && previous.markers.has(marker)) return null;
    const markers = previous?.stamp === stamp ? previous.markers : new Set<string>();
    let complete = true;
    let cursor: WorkTurnPage['nextCursor'];
    do {
      const page = readCopilotHistory(file, sessionId, undefined, 10, 10, cursor, () => {
        complete = false;
      });
      if (page.availability === 'reply_unavailable') return null;
      const match = page.turns.find(
        (turn) =>
          turn.role === 'user' && (turn.text === marker || turn.text.startsWith(`${marker}\n`))
      );
      if (match) return match;
      cursor = page.nextCursor;
      if (cursor) await new Promise((done) => setTimeout(done, 0));
    } while (cursor);
    if (complete) {
      markers.add(marker);
      misses.set(key, { stamp, markers });
    }
    return null;
  };
}

const Event = z.object({
  type: z.string(),
  timestamp: z.string(),
  agentId: z.string().optional(),
  data: z.object({
    messageId: z.string().optional(),
    toolCallId: z.string().optional(),
    content: z.string().optional(),
    toolName: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.object({ content: z.string().optional() }).optional(),
  }),
});

export function readCopilotHistory(
  file: string,
  sessionId: string,
  around: string | undefined,
  before: number,
  after: number,
  cursor?: WorkTurnPage['nextCursor'],
  onUnparsed?: () => void
): WorkTurnPage {
  const unavailable: WorkTurnPage = { turns: [], availability: 'reply_unavailable' };
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    const stamp = `${info.dev}:${info.ino}`;
    if (
      cursor &&
      (!cursor.copilot ||
        cursor.sessionId !== sessionId ||
        cursor.copilot.stamp !== stamp ||
        info.size < cursor.copilot.size)
    )
      return unavailable;
    const end = Math.min(cursor?.before ?? info.size, info.size);
    const start = Math.max(0, end - 262144);
    const bytes = Buffer.alloc(end - start);
    const count = readSync(fd, bytes, 0, bytes.length, start);
    if (!count) return unavailable;
    const last = bytes.lastIndexOf(10, count - 1);
    let position = start ? bytes.indexOf(10) + 1 : 0;
    const firstLine = start + position;
    const turns: (WorkTurnPage['turns'][number] & { position: number })[] = [];
    const seen = new Set<string>();
    let incomplete = last !== count - 1;
    if (last < 0 || (start && !position)) {
      onUnparsed?.();
      return {
        ...unavailable,
        availability: 'incomplete',
        ...(start
          ? { nextCursor: { sessionId, before: start, copilot: { stamp, size: info.size } } }
          : {}),
      };
    }
    while (position <= last) {
      const newline = bytes.indexOf(10, position);
      const offset = position;
      position = newline + 1;
      let event: z.infer<typeof Event>;
      try {
        event = Event.parse(JSON.parse(bytes.subarray(offset, newline).toString('utf8')));
      } catch {
        incomplete = true;
        continue;
      }
      if (event.agentId) continue;
      const { data, type } = event;
      const role =
        type === 'user.message'
          ? 'user'
          : type === 'assistant.message'
            ? 'assistant'
            : ['tool.execution_start', 'tool.execution_complete'].includes(type)
              ? 'tool'
              : undefined;
      const id = role === 'tool' ? data.toolCallId : data.messageId;
      const text =
        role === 'tool'
          ? type === 'tool.execution_start'
            ? `${data.toolName ?? 'tool'} ${JSON.stringify(data.arguments ?? {})}`
            : data.result?.content
          : data.content;
      const messageId = `${role}:${role === 'tool' ? type + ':' : ''}${id}`;
      const at = Date.parse(event.timestamp);
      if (!role || !id || typeof text !== 'string' || !Number.isFinite(at) || seen.has(messageId))
        continue;
      seen.add(messageId);
      const clip = text.length > 4000 && /[\uD800-\uDBFF]/.test(text[3999]) ? 3999 : 4000;
      turns.push({
        messageId,
        role,
        at,
        text: text.slice(0, clip),
        textComplete: text.length <= 4000,
        position: start + offset,
      });
    }
    if (incomplete) onUnparsed?.();
    const anchor = around ? turns.findIndex((t) => t.messageId === around) : -1;
    if (around && anchor < 0) return unavailable;
    const selected = around
      ? turns.slice(Math.max(0, anchor - before), anchor + after + 1)
      : turns.slice(-Math.min(21, before + after + 1));
    const boundary = selected[0]?.position ?? (firstLine < end ? firstLine : start);
    const older = start > 0 || (selected.length > 0 && turns[0].position < boundary);
    return {
      turns: selected.map(({ position: _position, ...turn }) => turn),
      availability:
        incomplete || older || selected.some((t) => !t.textComplete)
          ? 'incomplete'
          : selected.length || cursor
            ? 'complete'
            : 'reply_unavailable',
      ...(older
        ? { nextCursor: { sessionId, before: boundary, copilot: { stamp, size: info.size } } }
        : {}),
    };
  } catch {
    return unavailable;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
