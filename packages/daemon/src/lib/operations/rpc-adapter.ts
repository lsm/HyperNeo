import { resolveOperationRegistry } from './registry.ts';
import {
  ErrorCode,
  MessageHubHandlerError,
  type CallContext,
  type RequestHandler,
} from '@hyperneo/shared';
import { z } from 'zod';
import { invokeOperation } from './invoke.ts';
import { LOCAL_RPC_PRINCIPAL, type CallerIdentity } from './caller.ts';
import type { OperationRegistrySource } from './registry.ts';

const InvocationSchema = z.object({ name: z.string().min(1), input: z.unknown().optional() });

export function createOperationRpcHandler(
  registry: OperationRegistrySource,
  resolveCaller: (context: CallContext) => CallerIdentity | Promise<CallerIdentity>
): RequestHandler {
  return async (data, context) => {
    const parsed = InvocationSchema.safeParse(data);
    if (!parsed.success) {
      throw new MessageHubHandlerError(parsed.error.message, ErrorCode.INVALID_PARAMS);
    }
    const caller = await resolveCaller(context);
    const outcome = await invokeOperation(
      resolveOperationRegistry(registry),
      parsed.data.name,
      parsed.data.input,
      {
        ...caller,
        source: 'rpc',
        principal: LOCAL_RPC_PRINCIPAL,
      }
    );
    if (outcome.kind === 'completed') return outcome.value;
    const code =
      outcome.code === 'unknown_operation'
        ? ErrorCode.METHOD_NOT_FOUND
        : outcome.code === 'invalid_input'
          ? ErrorCode.INVALID_PARAMS
          : ErrorCode.HANDLER_ERROR;
    throw new MessageHubHandlerError(outcome.message, code);
  };
}
