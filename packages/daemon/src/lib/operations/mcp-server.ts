import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import desktopCatalog from '../desktop/tool-catalog.json' with { type: 'json' };
import { DESKTOP_MCP_SERVER_NAME } from '../desktop/worker-profile.ts';
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
  reportTarget?: () => { to: string; todoId: string } | undefined,
  fullDesktopSnapshots?: () => boolean,
];

const DesktopReport = z.object({
  kind: z.enum(['done', 'question', 'blocked', 'failed']),
  text: z.string().trim().min(1),
  question: z
    .object({
      title: z.string().trim().min(1).max(80),
      options: z.array(z.string().trim().min(1).max(80)).min(2).max(6),
      language: z.enum(['en', 'zh-Hans']),
    })
    .optional(),
});

export function registerOperationMcpTools(
  register: RegisterOperationTool,
  ...[
    registry,
    resolveCaller,
    recordRefusal,
    descriptionRole,
    reportTarget,
    fullDesktopSnapshots,
  ]: OperationMcpRegistration
) {
  const invoke = createOperationMcpHandler(
    registry,
    resolveCaller,
    recordRefusal,
    fullDesktopSnapshots
  );
  if (descriptionRole === 'desktop') {
    for (const { name, description, inputSchema } of desktopCatalog) {
      const schema = z.fromJSONSchema(
        inputSchema as unknown as z.core.JSONSchema.JSONSchema
      ) as z.ZodObject;
      register(name, description, schema.shape, (args) =>
        invoke({ name: 'desktop.call', input: { tool: name, args } })
      );
    }
    register(
      'report',
      'Send a result, question or blocker for the assigned task.',
      DesktopReport.shape,
      async (args) => {
        const { kind, text, question } = DesktopReport.parse(args);
        const target = reportTarget?.();
        if (!target || (question && kind !== 'question' && kind !== 'blocked')) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Report needs an active task and a valid kind.' }],
          };
        }
        const receipt = await invoke({
          name: 'message.send',
          input: {
            to: target.to,
            kind,
            text,
            ...(question ? { question: { ...question, todoId: target.todoId } } : {}),
          },
        });
        return JSON.parse(receipt.content[0].text)?.kind === 'accepted'
          ? { content: [{ type: 'text', text: 'Report received.' }] }
          : { isError: true, content: [{ type: 'text', text: 'Report was not delivered.' }] };
      }
    );
    return;
  }
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
  }
}

export function createOperationMcpServer(...registration: OperationMcpRegistration) {
  const tools: NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']> = [];
  registerOperationMcpTools((...args) => tools.push(tool(...args)), ...registration);
  return createSdkMcpServer({
    name: registration[3] === 'desktop' ? DESKTOP_MCP_SERVER_NAME : OPERATIONS_MCP_SERVER_NAME,
    tools,
  });
}
