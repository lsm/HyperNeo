import superpipe, { type PipelineAPI } from 'superpipe';
import { invokeOperation } from '../../operations/invoke.ts';
import { resolveOperationRegistry } from '../../operations/registry.ts';
import type { OperationCaller, OperationRegistrySource } from '../../operations/registry.ts';
import { jsonResult, type ToolResult } from '../tools/tool-result.ts';

export type OperationActionRejection = { reject: string };

export function isOperationActionRejection(value: unknown): value is OperationActionRejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { reject: unknown }).reject === 'string'
  );
}

export type MappedActionParams = { params: unknown; mappedParams: unknown };

export async function mapActionParams(
  params: unknown,
  mapParams: (params: unknown) => unknown | Promise<unknown>
): Promise<{ value: MappedActionParams } | { reason: ToolResult }> {
  const mapped = await mapParams(params);
  return isOperationActionRejection(mapped)
    ? { reason: jsonResult({ success: false, error: mapped.reject }) }
    : { value: { params, mappedParams: mapped } };
}

export type OperationResultMapper = (
  value: unknown,
  originalParams: unknown
) => unknown | Promise<unknown>;

export async function invokeMappedOperation(
  mapped: MappedActionParams,
  registry: OperationRegistrySource,
  operationName: string,
  caller: OperationCaller,
  mapResult: OperationResultMapper = (value) => value
): Promise<ToolResult> {
  const outcome = await invokeOperation(
    resolveOperationRegistry(registry),
    operationName,
    mapped.mappedParams,
    caller
  );
  if (outcome.kind !== 'completed') {
    return { ...jsonResult({ code: outcome.code, message: outcome.message }), isError: true };
  }
  const resultValue = await mapResult(outcome.value, mapped.params);
  return jsonResult(resultValue);
}

export function createOperationActionHandler(
  registry: OperationRegistrySource,
  caller: Omit<OperationCaller, 'source'>,
  operationName: string,
  mapParams: (params: unknown) => unknown | Promise<unknown> = (params) => params,
  mapResult: OperationResultMapper = (value) => value
): (params: unknown) => Promise<unknown> {
  const mcpCaller: OperationCaller = { ...caller, source: 'mcp' };
  return (
    superpipe({ registry, operationName, caller: mcpCaller, mapParams, mapResult })(
      'operation-action'
    ) as PipelineAPI
  )
    .input('params')
    .pipe(mapActionParams, ['params', 'mapParams'], 'result:mapped')
    .pipe(
      invokeMappedOperation,
      ['mapped', 'registry', 'operationName', 'caller', 'mapResult'],
      'mapped'
    )
    .endAsync('mapped') as (params: unknown) => Promise<unknown>;
}
