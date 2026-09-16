import type { OperationDefinition } from '../operations/registry.ts';
import {
  createForgeScopeOperations,
  type ForgeScopeOperationDependencies,
} from './scope-operations.ts';

export type ForgeOperationDependencies = ForgeScopeOperationDependencies;

export function createForgeOperations(forge: ForgeOperationDependencies): OperationDefinition[] {
  return [...createForgeScopeOperations(forge)];
}
