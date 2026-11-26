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

export function createOperationMcpServer(
  registry: OperationRegistrySource,
  resolveCaller: (operation: string) => CallerIdentity | Promise<CallerIdentity>,
  recordRefusal?: (refusal: OperationRefusal) => void | Promise<void>,
  descriptionRole?: OperationCallerRole | 'desktop',
  fullDesktopSnapshots?: () => boolean
) {
  const handle = createOperationMcpHandler(registry, resolveCaller, recordRefusal);
  const invoke = (args: z.infer<typeof OperationMcpInvocationSchema>) => {
    const input = args.input;
    if (
      args.name === 'desktop.call' &&
      input?.tool === 'get_window_state' &&
      fullDesktopSnapshots?.()
    ) {
      const read = z.looseObject({ since: z.unknown().optional() }).safeParse(input.args);
      if (read.success) {
        const { since: _since, ...full } = read.data;
        return handle({ ...args, input: { ...input, args: full } });
      }
    }
    return handle(args);
  };
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
    const operations = resolveOperationRegistry(registry);
    for (const family of NEO_RESIDENT_FAMILIES) {
      const schema =
        family.actions.length === 1
          ? z.object({ input: z.looseObject({}), action: z.never().optional() })
          : z.object({ action: z.enum(family.actions), input: z.looseObject({}) });
      tools.push(
        tool(
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
        )
      );
    }
  } else if (descriptionRole === 'desktop') {
    for (const { name, description, inputSchema } of desktopCatalog) {
      const schema = z.fromJSONSchema(
        inputSchema as unknown as z.core.JSONSchema.JSONSchema
      ) as z.ZodObject;
      tools.push(
        tool(name, description, schema.shape, (args) =>
          invoke({ name: 'desktop.call', input: { tool: name, args } })
        )
      );
    }
  }
  return createSdkMcpServer({ name: OPERATIONS_MCP_SERVER_NAME, tools });
}
