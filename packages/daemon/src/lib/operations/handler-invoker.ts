import { LOCAL_RPC_PRINCIPAL } from './caller.ts';
import { invokeOperation } from './invoke.ts';
import { resolveOperationRegistry, type OperationRegistrySource } from './registry.ts';

export type OperationRejectionEnvelope =
  | { accepted: false; message?: string }
  | { rejected: true; message?: string };

export type OperationAcceptanceEnvelope = { accepted: true };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isAcceptanceEnvelope(value: unknown): value is OperationAcceptanceEnvelope {
  return asRecord(value)?.accepted === true;
}

function isRejectionEnvelope(value: unknown): value is OperationRejectionEnvelope {
  const record = asRecord(value);
  if (record === null) return false;
  return record.accepted === false || record.rejected === true;
}

function rejectionMessage(rejection: OperationRejectionEnvelope, name: string): string {
  return typeof rejection.message === 'string' && rejection.message.length > 0
    ? rejection.message
    : `Operation ${name} was rejected without a message`;
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
  if (isAcceptanceEnvelope(outcome.value)) return outcome.value as Result;
  if (isRejectionEnvelope(outcome.value)) throw new Error(rejectionMessage(outcome.value, name));
  throw new Error(
    `Operation ${name} returned a result the handler seam does not recognize; ` +
      'expected { accepted: true } or a rejection envelope'
  );
}
