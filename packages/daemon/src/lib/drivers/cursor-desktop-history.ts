import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkTurnPage } from '../../storage/work-turn-page.ts';

type Cursor = WorkTurnPage['nextCursor'];
const WINDOW = 512 * 1024;
const FILE_ID = /^[a-z0-9-]{1,128}$/i;
const Message = z.object({
  role: z.enum(['user', 'assistant']),
  message: z.object({
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ]),
  }),
});

async function transcript(root: string, id: string) {
  if (!FILE_ID.test(id)) return null;
  try {
    root = await realpath(root);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name, 'agent-transcripts');
      for (const path of [join(directory, id, `${id}.jsonl`), join(directory, `${id}.jsonl`)]) {
        if ((await realpath(path).catch(() => null)) === path)
          return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
    }
  } catch {}
  return null;
}

export async function readCursorDesktopHistory(
  root: string,
  id: string,
  around: string | undefined,
  before: number,
  after: number,
  cursor: Cursor
): Promise<WorkTurnPage | null> {
  const file = await transcript(root, id);
  if (!file) return null;
  try {
    const info = await file.stat();
    const stamp = `${info.dev}:${info.ino}`;
    if (
      !info.isFile() ||
      (cursor && (cursor.cursorDesktop?.stamp !== stamp || info.size < cursor.cursorDesktop.size))
    )
      return null;
    const anchor = around?.startsWith('cursor:') ? Number(around.slice(7)) : undefined;
    if (around && (anchor === undefined || !Number.isSafeInteger(anchor) || anchor < 0))
      return null;
    const end = Math.min(
      cursor?.before ?? (anchor === undefined ? info.size : anchor + WINDOW),
      info.size
    );
    const start = Math.max(0, (anchor ?? end) - WINDOW);
    if (start >= end) return null;
    const bytes = Buffer.alloc(end - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    const limit = bytes.lastIndexOf(10, bytesRead - 1);
    let offset = start ? bytes.indexOf(10) + 1 : 0;
    let incomplete = limit !== bytesRead - 1;
    const entries: { offset: number; turn: WorkTurnPage['turns'][number] }[] = [];
    while (limit >= 0 && offset <= limit && (!start || offset > 0)) {
      const newline = bytes.indexOf(10, offset);
      const position = start + offset;
      const value = bytes.subarray(offset, newline).toString('utf8');
      offset = newline + 1;
      let body: unknown;
      try {
        body = JSON.parse(value);
      } catch {
        incomplete = true;
        continue;
      }
      const parsed = Message.safeParse(body);
      if (!parsed.success) continue;
      const { role, message } = parsed.data;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter(({ type }) => type === 'text')
              .map(({ text }) => text ?? '')
              .join('\n');
      if (!text.trim()) continue;
      const clip = text.length > 3000 && /[\uD800-\uDBFF]/.test(text[2999]) ? 2999 : 3000;
      entries.push({
        offset: position,
        turn: {
          messageId: `cursor:${position}`,
          role,
          at: 0,
          text: text.slice(0, clip),
          textComplete: text.length <= clip,
        },
      });
    }
    const index = anchor === undefined ? -1 : entries.findIndex((entry) => entry.offset === anchor);
    if (anchor !== undefined && index < 0) return null;
    const selected =
      index < 0
        ? entries.slice(-(before + after + 1))
        : entries.slice(Math.max(0, index - before), index + after + 1);
    const boundary = selected[0]?.offset ?? start;
    const older = boundary > 0 && (start > 0 || entries[0]?.offset < boundary);
    return {
      turns: selected.map(({ turn }) => turn),
      availability:
        older || incomplete ? 'incomplete' : selected.length ? 'complete' : 'reply_unavailable',
      ...(older
        ? {
            nextCursor: {
              sessionId: id,
              before: boundary,
              cursorDesktop: { stamp, size: info.size },
            },
          }
        : {}),
    };
  } catch {
    return null;
  } finally {
    await file.close();
  }
}
