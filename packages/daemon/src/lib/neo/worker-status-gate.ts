export function neoSyncedWorkers(
  rows: readonly { adapter: string; id: string; status: string; at: number }[]
): Map<string, string> {
  return new Map(rows.map((row) => [`${row.adapter}:${row.id}`, `${row.status}:${row.at}`]));
}

export function neoWorkerStatusDue(synced: string | undefined, seen: string | undefined): boolean {
  return synced === undefined || synced !== seen;
}
