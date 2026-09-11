export function toReminderCounts(counts: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(counts));
}

export function reminderLabel(count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  return `${count} reminder${count === 1 ? '' : 's'}`;
}
