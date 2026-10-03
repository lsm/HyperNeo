function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structurallyEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || !structurallyEqual(a[key], b[key])) return false;
  }
  return true;
}

interface TurnRowProps {
  turn: unknown;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}

export function areTurnRowPropsEqual(prev: TurnRowProps, next: TurnRowProps): boolean {
  return (
    prev.overlayTaskId === next.overlayTaskId &&
    prev.overlayTaskReadonly === next.overlayTaskReadonly &&
    structurallyEqual(prev.turn, next.turn)
  );
}
