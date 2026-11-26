import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import {
  createOperationMcpHandler,
  OperationMcpInvocationSchema,
  type OperationRefusal,
} from './mcp-adapter.ts';
import type { CallerIdentity } from './caller.ts';
import {
  resolveOperationRegistry,
  type OperationCallerRole,
  type OperationRegistrySource,
} from './registry.ts';
import { z } from 'zod';
import {
  NEO_RESIDENT_FAMILIES,
  residentOperation,
  residentToolDescription,
} from './resident-tools.ts';

type RegisterOperationTool = (
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: ReturnType<typeof createOperationMcpHandler>
) => void;

type OperationMcpRegistration = [
  registry: OperationRegistrySource,
  resolveCaller: (operation: string) => CallerIdentity | Promise<CallerIdentity>,
  recordRefusal?: (refusal: OperationRefusal) => void | Promise<void>,
  descriptionRole?: OperationCallerRole,
];

export function registerOperationMcpTools(
  register: RegisterOperationTool,
  ...[registry, resolveCaller, recordRefusal, descriptionRole]: OperationMcpRegistration
) {
  const invoke = createOperationMcpHandler(registry, resolveCaller, recordRefusal);
  const discovery =
    descriptionRole === 'neo'
      ? 'operations.list {prefix,cursor?}; operations.describe {name}. message.send acceptance means durable mailbox persistence, not an agent reply.'
      : 'operations.list discovers others; operations.describe {name} returns full schemas.';
  register(
    'invoke',
    descriptionRole === 'neo'
      ? discovery
      : `Invoke {name,input}. ${discovery} message.send acceptance means durable mailbox persistence, not an agent reply.`,
    OperationMcpInvocationSchema.shape,
    invoke
  );
  if (descriptionRole === 'neo') {
    const operations = resolveOperationRegistry(registry);
    for (const family of NEO_RESIDENT_FAMILIES) {
      const schema =
        family.actions.length === 1
          ? z.object({ input: z.looseObject({}), action: z.never().optional() })
          : z.object({ action: z.enum(family.actions), input: z.looseObject({}) });
      register(
        family.name,
        residentToolDescription(family, operations),
        schema.shape,
        async (args) => {
          const input = schema.parse(args);
          const action =
            'action' in input && typeof input.action === 'string'
              ? input.action
              : family.actions[0];
          return invoke({ name: residentOperation(family, action), input: input.input });
        }
      );
    }
  }
}

export function createOperationMcpServer(...registration: OperationMcpRegistration) {
  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [];
  registerOperationMcpTools((...args) => tools.push(tool(...args)), ...registration);
  return createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools });
}
