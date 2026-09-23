const SUBSCRIPTION_METADATA_KEYS = new Set(['label']);

export function eventMatchesFilter(
  filter: Record<string, unknown> | undefined,
  payload: Record<string, unknown>
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (payload[key] !== expected) return false;
  }
  return true;
}

export function subscriptionEventFilter(
  filter: Record<string, unknown> | undefined
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filter ?? {}).filter(([key]) => !SUBSCRIPTION_METADATA_KEYS.has(key))
  );
}
