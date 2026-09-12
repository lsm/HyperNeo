import superpipe, { type PipelineAPI } from 'superpipe';
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

async function mapActionParams(
  params: unknown,
  mapParams: (params: unknown) => unknown | Promise<unknown>
): Promise<{ value: unknown } | { reason: unknown }> {
  const mapped = await mapParams(params);
  return isOperationActionRejection(mapped)
    ? { reason: { ...jsonResult({ success: false, error: mapped.reject }), isError: true } }
    : { value: mapped };
}

async function invokeMappedOperation(
  mapped: unknown,
  registry: OperationRegistrySource,
  operationName: string,
  caller: OperationCaller
): Promise<unknown> {
  const outcome = await invokeOperation(
    resolveOperationRegistry(registry),
    operationName,
    mapped,
    caller
  );
  return outcome.kind === 'completed'
    ? jsonResult(outcome.value)
    : { ...jsonResult({ code: outcome.code, message: outcome.message }), isError: true };
}

export function createOperationActionHandler(
  registry: OperationRegistrySource,
  caller: Omit<OperationCaller, 'source'>,
  operationName: string,
  mapParams: (params: unknown) => unknown | Promise<unknown> = (params) => params
): (params: unknown) => Promise<unknown> {
  const mcpCaller: OperationCaller = { ...caller, source: 'mcp' };
  return (
    superpipe({ registry, operationName, caller: mcpCaller, mapParams })(
      'operation-action'
    ) as PipelineAPI
  )
    .input('params')
    .pipe(mapActionParams, ['params', 'mapParams'], 'result:mapped')
    .pipe(invokeMappedOperation, ['mapped', 'registry', 'operationName', 'caller'], 'mapped')
    .endAsync('mapped') as (params: unknown) => Promise<unknown>;
}
