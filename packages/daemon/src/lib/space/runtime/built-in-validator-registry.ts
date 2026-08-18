import type { BuiltInValidatorFn } from './hook-executor';

const builtInValidators = new Map<string, BuiltInValidatorFn>();

export function registerBuiltInValidator(id: string, fn: BuiltInValidatorFn): void {
  builtInValidators.set(id, fn);
}

export function getBuiltInValidator(id: string): BuiltInValidatorFn | undefined {
  return builtInValidators.get(id);
}

export function isRegisteredBuiltInValidator(id: string): boolean {
  return builtInValidators.has(id);
}

export function getRegisteredBuiltInValidatorIds(): string[] {
  return [...builtInValidators.keys()];
}

export function clearBuiltInValidatorRegistry(): void {
  builtInValidators.clear();
}
