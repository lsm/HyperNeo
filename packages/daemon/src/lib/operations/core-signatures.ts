import type { OperationName } from '@hyperneo/shared/types/operation-names';
import { NEO_RESIDENT_FAMILIES, residentOperation } from './resident-tools.ts';

export const NEO_CORE_OPERATION_NAMES: readonly OperationName[] = [
  ...NEO_RESIDENT_FAMILIES.flatMap((family) =>
    family.actions.map((action) => residentOperation(family, action))
  ),
  'neo.github.read',
  'neo.snapshot',
];
