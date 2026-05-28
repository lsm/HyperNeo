const GENERIC_TASK_RESULT_STRINGS = new Set([
  'An unexpected error occurred. Please try again or contact support if the issue persists.',
]);

export function normalizeMeaningfulTaskResult(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (GENERIC_TASK_RESULT_STRINGS.has(trimmed)) return null;
  return trimmed;
}
