import { open } from 'node:fs/promises';
import {
  claudeSessionLinks,
  claudeTranscriptPath,
  readClaudeDesktopRecords,
  type ClaudeDesktopRecord,
  type ClaudeRecordCache,
} from './claude-desktop-adapter.ts';

type TranscriptPrs = {
  identity: string;
  modifiedAt: number;
  size: number;
  offset: number;
  created: string[];
};

export function claudeCreatedPr(line: string): string | null {
  if (!line.includes('gitOperation')) return null;
  try {
    const entry = JSON.parse(line);
    const pr = entry?.toolUseResult?.gitOperation?.pr;
    return entry?.type === 'user' &&
      entry.isError !== true &&
      pr?.action === 'created' &&
      Number.isInteger(pr.number) &&
      typeof pr.url === 'string'
      ? pr.url
      : null;
  } catch {
    return null;
  }
}

async function readTranscriptPrs(path: string, known?: TranscriptPrs): Promise<TranscriptPrs> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}`;
    const reset =
      !known ||
      known.identity !== identity ||
      info.size < known.size ||
      (info.size === known.size && info.mtimeMs !== known.modifiedAt);
    if (!reset && info.size === known.size) return known;
    const created = new Set(reset ? [] : known.created);
    let offset = reset ? 0 : known.offset;
    const pending: Buffer[] = [];
    if (info.size > offset) {
      for await (const chunk of handle.createReadStream({
        start: offset,
        end: info.size - 1,
        autoClose: false,
        highWaterMark: 64 * 1024,
      })) {
        const buffer = chunk as Buffer;
        const end = buffer.lastIndexOf(0x0a);
        if (end < 0) pending.push(buffer);
        else {
          const complete = Buffer.concat([...pending, buffer.subarray(0, end + 1)]);
          for (const line of complete.toString('utf8').split('\n')) {
            const url = claudeCreatedPr(line);
            if (url) created.add(url);
          }
          offset += complete.length;
          pending.length = 0;
          if (end + 1 < buffer.length) pending.push(buffer.subarray(end + 1));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return { identity, modifiedAt: info.mtimeMs, size: info.size, offset, created: [...created] };
  } finally {
    await handle.close();
  }
}

export function createClaudeSessionPrReader(sessionsDir: string, projectsDir: string) {
  const records: ClaudeRecordCache = new Map();
  const transcripts = new Map<string, TranscriptPrs>();
  const links = new WeakMap<ClaudeDesktopRecord, ReturnType<typeof claudeSessionLinks>>();
  return async () => {
    const present = new Set<string>();
    const found = [];
    for (const record of await readClaudeDesktopRecords(sessionsDir, records)) {
      let linked = links.get(record);
      if (!linked) {
        linked = claudeSessionLinks(record);
        links.set(record, linked);
      }
      const path = claudeTranscriptPath(projectsDir, record);
      if (path) {
        present.add(path);
        try {
          transcripts.set(path, await readTranscriptPrs(path, transcripts.get(path)));
        } catch {}
      }
      found.push({
        record,
        ...linked,
        createdPrs: path ? (transcripts.get(path)?.created ?? []) : [],
      });
    }
    for (const path of transcripts.keys()) if (!present.has(path)) transcripts.delete(path);
    return found;
  };
}
