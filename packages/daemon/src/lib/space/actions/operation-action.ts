import { invokeOperation } from '../../operations/invoke.ts';
import { resolveOperationRegistry } from '../../operations/registry.ts';
import type { OperationCaller, OperationRegistrySource } from '../../operations/registry.ts';
import { jsonResult } from '../tools/tool-result.ts';

export type OperationActionRejection = { reject: string };

export function isOperationActionRejection(value: unknown): value is OperationActionRejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { reject: unknown }).reject === 'string'
  );
}

export function createOperationActionHandler(
  registry: OperationRegistrySource,
  caller: Omit<OperationCaller, 'source'>,
  operationName: string,
  mapParams: (params: unknown) => unknown | Promise<unknown> = (params) => params
): (params: unknown) => Promise<unknown> {
  return async (params: unknown) => {
    const mapped = await mapParams(params);
    if (isOperationActionRejection(mapped)) {
      return { ...jsonResult({ success: false, error: mapped.reject }), isError: true };
    }
    const outcome = await invokeOperation(
      resolveOperationRegistry(registry),
      operationName,
      mapped,
      { ...caller, source: 'mcp' }
    );
    if (outcome.kind === 'completed') return jsonResult(outcome.value);
    return { ...jsonResult({ code: outcome.code, message: outcome.message }), isError: true };
  };
}
