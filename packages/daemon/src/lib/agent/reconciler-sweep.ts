export interface SubmittedDeliveryRow {
  uuid?: string;
}

function submittedUuid(row: SubmittedDeliveryRow): string | null {
  const uuid = row.uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

export function isStaleSubmittedDelivery(
  row: SubmittedDeliveryRow,
  activeInJobQueue: ReadonlySet<string>
): boolean {
  const uuid = submittedUuid(row);
  return uuid !== null && !activeInJobQueue.has(uuid);
}

export function selectStaleSubmittedDeliveries(
  submitted: ReadonlyArray<SubmittedDeliveryRow>,
  activeInJobQueue: ReadonlySet<string>
): string[] {
  const stale: string[] = [];
  for (const row of submitted) {
    const uuid = submittedUuid(row);
    if (uuid !== null && !activeInJobQueue.has(uuid)) stale.push(uuid);
  }
  return stale;
}
