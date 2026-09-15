import type {
  DeclarativeToolGuard,
  McpServerConfig,
  EvolutionLesson,
  Space,
  SpaceLongHorizonAgent,
  SpaceGoal,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  ThinkingLevel,
} from '@hyperneo/shared';
import type {
  AgentMemoryCoreEntry,
  AgentMemorySearchResult,
} from '../../storage/repositories/agent-memory-repository.ts';

export interface SlotResolutionContext {
  agentId?: string;
  agentName?: string;
  workflowRunId?: string;
  workflowId?: string;
  nodeId?: string;
  nodeName?: string;
}

export interface SlotOverrides {
  model?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  customPrompt?: string;
  replaceAgentPrompt?: boolean;
  disabledSkillIds?: string[];
  extraMcpServers?: Record<string, McpServerConfig>;
  toolGuards?: DeclarativeToolGuard[];
  resolutionContext?: SlotResolutionContext;
}

export type UnifiedSpaceAgent = SpaceLongHorizonAgent;

export interface TaskMessageContext {
  reviewFeedback?: string | null;
  task: SpaceTask;
  workflowRun?: SpaceWorkflowRun | null;
  workflow?: SpaceWorkflow | null;
  space: Space;
  workspacePath: string;
  goal?: SpaceGoal | null;
  relevantScopeLessons?: EvolutionLesson[];
  previousTaskSummaries?: string[];
  nodeId?: string;
  agentSlotName?: string;
  coreMemories?: AgentMemoryCoreEntry[];
  relevantMemories?: AgentMemorySearchResult[];
}

export interface CustomAgentConfig extends TaskMessageContext {
  customAgent: UnifiedSpaceAgent;
  workflowRun: SpaceWorkflowRun | null;
  sessionId: string;
  slotOverrides?: SlotOverrides;
}
