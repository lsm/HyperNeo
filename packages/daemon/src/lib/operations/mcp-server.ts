import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import desktopCatalog from '../desktop/tool-catalog.json' with { type: 'json' };
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
  descriptionRole?: OperationCallerRole | 'desktop',
  fullDesktopSnapshots?: () => boolean,
];

export function registerOperationMcpTools(
  register: RegisterOperationTool,
  ...[
    registry,
    resolveCaller,
    recordRefusal,
    descriptionRole,
    fullDesktopSnapshots,
  ]: OperationMcpRegistration
) {
  const invoke = createOperationMcpHandler(
    registry,
    resolveCaller,
    recordRefusal,
    fullDesktopSnapshots
  );
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
      const run = async (args: unknown) => {
        const { action, input } = schema.parse(args);
        return invoke({ name: residentOperation(family, action ?? family.actions[0]), input });
      };
      register(family.name, residentToolDescription(family, operations), schema.shape, run);
    }
  } else if (descriptionRole === 'desktop') {
    for (const { name, description, inputSchema } of desktopCatalog) {
      const schema = z.fromJSONSchema(
        inputSchema as unknown as z.core.JSONSchema.JSONSchema
      ) as z.ZodObject;
      register(name, description, schema.shape, (args) =>
        invoke({ name: 'desktop.call', input: { tool: name, args } })
      );
    }
  }
}

export function createOperationMcpServer(...registration: OperationMcpRegistration) {
  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [];
  registerOperationMcpTools((...args) => tools.push(tool(...args)), ...registration);
  return createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools });
}
