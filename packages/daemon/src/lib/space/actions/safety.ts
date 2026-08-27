export const ACTION_SAFETY_CLASSES = ['read', 'mutate', 'destructive', 'human_only'] as const;

export type ActionSafetyClass = (typeof ACTION_SAFETY_CLASSES)[number];

export function isActionSafetyClass(value: unknown): value is ActionSafetyClass {
  return typeof value === 'string' && (ACTION_SAFETY_CLASSES as readonly string[]).includes(value);
}

export function isMutatingSafetyClass(safetyClass: ActionSafetyClass): boolean {
  return safetyClass !== 'read';
}
