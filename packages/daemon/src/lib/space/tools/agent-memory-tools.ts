import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  AgentMemoryRepository,
  AgentMemoryScope,
  AgentMemoryScopeFilter,
} from '../../../storage/repositories/agent-memory-repository';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';

const MemoryWriteSchema = z.object({
  key: z.string().min(1).max(200).describe('Stable memory key, unique within this Space.'),
  content: z
    .string()
    .min(1)
    .describe('Fact, convention, decision, or project knowledge to persist.'),
  tags: z.array(z.string()).optional().describe('Keyword tags that improve retrieval.'),
  scope: z
    .enum(['agent', 'space'])
    .optional()
    .describe(
      "Where to store this memory. 'agent' writes to this agent's private namespace (default for long-horizon agents); 'space' writes to the shared Space pool visible to everyone."
    ),
});

const MemorySearchSchema = z.object({
  query: z.string().min(1).describe('Natural language query or code identifier.'),
  limit: z.number().int().min(1).max(20).default(10),
  scope: z
    .enum(['mine', 'space', 'all'])
    .optional()
    .describe(
      "Which memories to search. Omit for this agent's private memories plus the shared Space pool. 'mine' = only this agent's private memories, 'space' = only the shared pool, 'all' = every memory in the Space."
    ),
});

const MemoryReadSchema = z.object({
  key: z.string().min(1).max(200).describe('Memory key to read.'),
  scope: z
    .enum(['mine', 'space', 'all'])
    .optional()
    .describe(
      "Which namespace to read from. Omit to prefer this agent's private memory, falling back to the shared pool. 'mine' = only this agent's, 'space' = only the shared pool, 'all' = either."
    ),
});

const MemoryDeleteSchema = z.object({
  key: z.string().min(1).max(200).describe('Memory key to delete.'),
  scope: z
    .enum(['mine', 'space', 'all'])
    .optional()
    .describe(
      "Which namespace to delete from. Omit to delete this agent's private memory and the shared entry under this key (never another agent's). 'space' = only the shared entry, 'all' = every entry under this key across owners."
    ),
});

export interface AgentMemoryToolsConfig {
  spaceId: string;
  memoryRepo: AgentMemoryRepository;
  mySessionId?: string;
  /**
   * The agent id that owns memories written/read through this tool instance.
   * Resolved from the calling session's `promptProvenance.agentId` at attach
   * time. When set, writes default to the agent's private namespace and
   * searches default to "mine + space". Omit for shared-only access (member /
   * space_chat / workflow-node sessions with no durable agent identity).
   */
  ownerAgentId?: string;
}

export function createAgentMemoryToolHandlers(config: AgentMemoryToolsConfig) {
  const { spaceId, memoryRepo, mySessionId, ownerAgentId } = config;
  return {
    async 'memory.write'(args: z.infer<typeof MemoryWriteSchema>): Promise<ToolResult> {
      const memory = memoryRepo.write({
        spaceId,
        key: args.key,
        content: args.content,
        // Pass `tags` through verbatim — including `undefined` — so the
        // repository can preserve previously stored tags on content-only
        // updates instead of clearing them with an explicit empty array.
        tags: args.tags,
        createdBySession: mySessionId ?? null,
        ownerAgentId,
        scope: args.scope as AgentMemoryScope | undefined,
      });
      return jsonResult({ success: true, memory });
    },

    async 'memory.search'(args: z.infer<typeof MemorySearchSchema>): Promise<ToolResult> {
      const results = await memoryRepo.search(spaceId, args.query, args.limit, {
        ownerAgentId,
        scope: args.scope as AgentMemoryScopeFilter | undefined,
      });
      return jsonResult({ success: true, results });
    },

    async 'memory.read'(args: z.infer<typeof MemoryReadSchema>): Promise<ToolResult> {
      const memory = memoryRepo.read(spaceId, args.key, {
        ownerAgentId,
        scope: args.scope as AgentMemoryScopeFilter | undefined,
      });
      if (!memory) return jsonResult({ success: false, error: `Memory not found: ${args.key}` });
      return jsonResult({ success: true, memory });
    },

    async 'memory.delete'(args: z.infer<typeof MemoryDeleteSchema>): Promise<ToolResult> {
      return jsonResult({
        success: true,
        deleted: memoryRepo.delete(spaceId, args.key, {
          ownerAgentId,
          scope: args.scope as AgentMemoryScopeFilter | undefined,
        }),
      });
    },
  };
}

export function createAgentMemoryMcpServer(config: AgentMemoryToolsConfig) {
  const handlers = createAgentMemoryToolHandlers(config);
  const tools = [
    tool(
      'memory.write',
      'Save a fact, convention, decision, or project knowledge to persistent Space memory for future agent sessions.',
      MemoryWriteSchema.shape,
      (args) => handlers['memory.write'](args)
    ),
    tool(
      'memory.search',
      'Search persistent Space memory for relevant facts, conventions, decisions, or project knowledge from previous sessions.',
      MemorySearchSchema.shape,
      (args) => handlers['memory.search'](args)
    ),
    tool(
      'memory.read',
      'Read one persistent Space memory by key.',
      MemoryReadSchema.shape,
      (args) => handlers['memory.read'](args)
    ),
    tool(
      'memory.delete',
      'Delete one persistent Space memory by key when it is obsolete or wrong.',
      MemoryDeleteSchema.shape,
      (args) => handlers['memory.delete'](args)
    ),
  ];
  const server = createSdkMcpServer({
    name: 'agent-memory',
    tools,
  });
  return { ...server, tools };
}
