import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentMemoryRepository } from '../../../storage/repositories/agent-memory-repository';
import type { ToolResult } from './tool-result';
import { jsonResult } from './tool-result';

const MemoryWriteSchema = z.object({
  key: z.string().min(1).max(200).describe('Stable memory key, unique within this Space.'),
  content: z
    .string()
    .min(1)
    .describe('Fact, convention, decision, or project knowledge to persist.'),
  tags: z.array(z.string()).optional().describe('Keyword tags that improve retrieval.'),
});

const MemorySearchSchema = z.object({
  query: z.string().min(1).describe('Natural language query or code identifier.'),
  limit: z.number().int().min(1).max(20).default(10),
});

const MemoryReadSchema = z.object({
  key: z.string().min(1).max(200).describe('Memory key to read.'),
});

const MemoryDeleteSchema = z.object({
  key: z.string().min(1).max(200).describe('Memory key to delete.'),
});

export interface AgentMemoryToolsConfig {
  spaceId: string;
  memoryRepo: AgentMemoryRepository;
  mySessionId?: string;
}

export function createAgentMemoryToolHandlers(config: AgentMemoryToolsConfig) {
  const { spaceId, memoryRepo, mySessionId } = config;
  return {
    async 'memory.write'(args: z.infer<typeof MemoryWriteSchema>): Promise<ToolResult> {
      const memory = memoryRepo.write({
        spaceId,
        key: args.key,
        content: args.content,
        tags: args.tags,
        createdBySession: mySessionId ?? null,
      });
      return jsonResult({ success: true, memory });
    },

    async 'memory.search'(args: z.infer<typeof MemorySearchSchema>): Promise<ToolResult> {
      const results = await memoryRepo.search(spaceId, args.query, args.limit);
      return jsonResult({ success: true, results });
    },

    async 'memory.read'(args: z.infer<typeof MemoryReadSchema>): Promise<ToolResult> {
      const memory = memoryRepo.read(spaceId, args.key);
      if (!memory) return jsonResult({ success: false, error: `Memory not found: ${args.key}` });
      return jsonResult({ success: true, memory });
    },

    async 'memory.delete'(args: z.infer<typeof MemoryDeleteSchema>): Promise<ToolResult> {
      return jsonResult({ success: true, deleted: memoryRepo.delete(spaceId, args.key) });
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
