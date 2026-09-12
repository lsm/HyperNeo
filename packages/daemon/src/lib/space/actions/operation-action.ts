import { invokeOperation } from '../../operations/invoke.ts';
import { resolveOperationRegistry } from '../../operations/registry.ts';
import type { OperationCaller, OperationRegistrySource } from '../../operations/registry.ts';
import { jsonResult } from '../tools/tool-result.ts';

export function createOperationActionHandler(
  registry: OperationRegistrySource,
  caller: Omit<OperationCaller, 'source'>,
  operationName: string,
  mapParams: (params: unknown) => unknown = (params) => params
): (params: unknown) => Promise<unknown> {
  return async (params: unknown) => {
    const outcome = await invokeOperation(
      resolveOperationRegistry(registry),
      operationName,
      mapParams(params),
      { ...caller, source: 'mcp' }
    );
    if (outcome.kind === 'completed') return jsonResult(outcome.value);
    return { ...jsonResult({ code: outcome.code, message: outcome.message }), isError: true };
  };
}
