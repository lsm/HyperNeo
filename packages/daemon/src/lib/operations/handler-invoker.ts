import { LOCAL_RPC_PRINCIPAL } from './caller.ts';
import { invokeOperation } from './invoke.ts';
import { resolveOperationRegistry, type OperationRegistrySource } from './registry.ts';

export type OperationRejectionEnvelope = { accepted: false; message: string };

export type OperationAcceptanceEnvelope = { accepted: true };

function isRejectionEnvelope(value: unknown): value is OperationRejectionEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as { accepted?: unknown; message?: unknown };
  return envelope.accepted === false && typeof envelope.message === 'string';
}

export async function invokeOperationFromHandler<Result extends OperationAcceptanceEnvelope>(
  registry: OperationRegistrySource,
  name: string,
  input: unknown
): Promise<Result> {
  const outcome = await invokeOperation(resolveOperationRegistry(registry), name, input, {
    source: 'rpc',
    principal: LOCAL_RPC_PRINCIPAL,
  });
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  if (isRejectionEnvelope(outcome.value)) throw new Error(outcome.value.message);
  return outcome.value as Result;
}
