import type { NeoBinding } from '@hyperneo/shared/types/neo-context';

type MainNeoBinding = NeoBinding & { kind: 'neo'; projectId: null };

export function isMainNeoBinding(
  binding: NeoBinding | null | undefined
): binding is MainNeoBinding {
  return binding?.kind === 'neo' && binding.projectId === null;
}

export function isNeoCoordinatorBinding(
  binding: NeoBinding | null | undefined
): binding is NeoBinding {
  return isMainNeoBinding(binding) || (binding?.kind === 'project' && binding.projectId !== null);
}
