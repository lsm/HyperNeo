import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import {
  createOperationMcpHandler,
  OperationMcpInvocationSchema,
  type OperationRefusal,
} from './mcp-adapter.ts';
import type { CallerIdentity } from './caller.ts';
import { type OperationCallerRole, type OperationRegistrySource } from './registry.ts';
import { z } from 'zod';
import { NEO_RESIDENT_FAMILIES, residentOperation } from './resident-tools.ts';

export function createOperationMcpServer(
  registry: OperationRegistrySource,
  resolveCaller: () => CallerIdentity | Promise<CallerIdentity>,
  recordRefusal?: (refusal: OperationRefusal) => void | Promise<void>,
  descriptionRole?: OperationCallerRole,
  speaking = true
) {
  const invoke = createOperationMcpHandler(registry, resolveCaller, recordRefusal);
  const discovery =
    descriptionRole === 'neo'
      ? 'operations.list {prefix,cursor?}; operations.describe {name}. message.send acceptance means durable mailbox persistence, not an agent reply.'
      : 'operations.list discovers others; operations.describe {name} returns full schemas.';
  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [
    tool(
      'invoke',
      descriptionRole === 'neo'
        ? discovery
        : `Invoke {name,input}. ${discovery} message.send acceptance means durable mailbox persistence, not an agent reply.`,
      OperationMcpInvocationSchema.shape,
      invoke
    ),
  ];
  if (descriptionRole === 'neo') {
    for (const family of NEO_RESIDENT_FAMILIES) {
      if (!speaking && (family.name === 'neo_publish' || family.name === 'neo_speech')) continue;
      const schema =
        family.actions.length === 1
          ? z.object({ input: z.looseObject({}), action: z.never().optional() })
          : z.object({ action: z.enum(family.actions), input: z.looseObject({}) });
      tools.push(
        tool(family.name, family.description, schema.shape, async (args) => {
          const input = schema.parse(args);
          const action =
            'action' in input && typeof input.action === 'string'
              ? input.action
              : family.actions[0];
          return invoke({ name: residentOperation(family, action), input: input.input });
        })
      );
    }
  }
  return createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools });
}
