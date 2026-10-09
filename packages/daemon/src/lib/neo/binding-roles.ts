import type { NeoBinding } from '@hyperneo/shared/types/neo-context';

export type MainNeoBinding = NeoBinding & { kind: 'neo'; concernId: null };

export function isMainNeoBinding(
  binding: NeoBinding | null | undefined
): binding is MainNeoBinding {
  return binding?.kind === 'neo' && binding.concernId === null;
}

export function isNeoCoordinatorBinding(
  binding: NeoBinding | null | undefined
): binding is NeoBinding {
  return isMainNeoBinding(binding) || (binding?.kind === 'concern' && binding.concernId !== null);
}
