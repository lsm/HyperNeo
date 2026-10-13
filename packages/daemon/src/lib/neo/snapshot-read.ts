export interface NeoSnapshotRead {
  rev: string;
  compaction: number;
}

export function planNeoSnapshotRead<T extends { ok: boolean; rev?: string; unchanged?: true }>(
  read: T,
  last: NeoSnapshotRead | null,
  compaction: number
):
  | { result: T; remember: NeoSnapshotRead | null }
  | {
      result: { ok: true; unchanged: true; rev: string; note: string; scopedTo?: string };
      remember: null;
    } {
  if (!read.ok || read.unchanged || !read.rev) return { result: read, remember: null };
  if (last?.rev !== read.rev || last.compaction !== compaction)
    return { result: read, remember: { rev: read.rev, compaction } };
  const scoped = (read as { scopedTo?: string }).scopedTo;
  return {
    result: {
      ok: true,
      unchanged: true,
      rev: read.rev,
      note: `unchanged since your last read (rev ${read.rev}): nothing changed. Read again only after a new event; if nothing else is left, end the turn.`,
      ...(scoped ? { scopedTo: scoped } : {}),
    },
    remember: null,
  };
}
