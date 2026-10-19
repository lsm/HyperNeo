export interface NeoSnapshotRead {
  rev: string;
  compaction: number;
}

export const NEO_SNAPSHOT_UNCHANGED_GUIDANCE =
  'Waiting here does not bring news: work reports and trigger notes arrive as new messages, and trigger notes are held until this turn ends, so reading again only delays them.';

export function planNeoSnapshotRead<T extends { ok: boolean; rev?: string; unchanged?: true }>(
  read: T,
  last: NeoSnapshotRead | null,
  compaction: number
):
  | { result: T; remember: NeoSnapshotRead | null }
  | {
      result: { ok: true; unchanged: true; rev: string; note: string };
      remember: null;
    } {
  if (!read.ok || read.unchanged || !read.rev) return { result: read, remember: null };
  if (last?.rev !== read.rev || last.compaction !== compaction)
    return { result: read, remember: { rev: read.rev, compaction } };
  return {
    result: {
      ok: true,
      unchanged: true,
      rev: read.rev,
      note: `unchanged since your last read (rev ${read.rev}): nothing changed. ${NEO_SNAPSHOT_UNCHANGED_GUIDANCE}`,
    },
    remember: null,
  };
}

const NEO_SNAPSHOT_READS_KEPT = 256;

export function rememberNeoSnapshotRead(
  reads: Map<string, NeoSnapshotRead>,
  key: string,
  read: NeoSnapshotRead
): void {
  reads.delete(key);
  reads.set(key, read);
  for (const oldest of reads.keys()) {
    if (reads.size <= NEO_SNAPSHOT_READS_KEPT) break;
    reads.delete(oldest);
  }
}
