export function decideReconcileAdmission(args: {
  processingStatus: string;
}): { action: 'skip' } | { action: 'run' } {
  if (
    args.processingStatus === 'processing' ||
    args.processingStatus === 'queued' ||
    args.processingStatus === 'waiting_for_input'
  ) {
    return { action: 'skip' };
  }
  return { action: 'run' };
}

export function selectStrandedDeliveries(
  enqueued: Array<{ uuid?: string }>,
  activeInJobQueue: ReadonlySet<string>,
  isInFlight?: (uuid: string) => boolean
): string[] {
  const stranded: string[] = [];
  for (const msg of enqueued) {
    const uuid = msg.uuid;
    if (
      typeof uuid === 'string' &&
      uuid.length > 0 &&
      !activeInJobQueue.has(uuid) &&
      !(isInFlight?.(uuid) ?? false)
    ) {
      stranded.push(uuid);
    }
  }
  return stranded;
}
