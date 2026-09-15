import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { EvolutionScope, SpaceTask } from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';

export const CONVERSATION_ANALYSIS_VERSION = 1;
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
export const PATTERN_KINDS = [
  'human_correction',
  'human_repetition',
  'agent_misunderstanding',
  'scope_creep',
  'requirement_confusion',
  'agent_apology',
  'synthetic_interruption',
] as const;
export const SEVERITIES = ['low', 'medium', 'high'] as const;

export type TraceMessageRole = 'human' | 'synthetic_user' | 'assistant' | 'thinking';
export type ConversationFrictionKind = (typeof PATTERN_KINDS)[number];
export type ConversationFrictionSeverity = (typeof SEVERITIES)[number];

export interface TraceMessage {
  role: TraceMessageRole;
  text: string;
  timestamp: number;
  metadata: {
    sessionId: string;
    messageId: string;
  };
}

export interface ConversationFrictionPattern {
  kind: ConversationFrictionKind;
  confidence: number;
  summary: string;
  involvedMessages: string[];
  severity: ConversationFrictionSeverity;
}

export interface ConversationFrictionAnalysis {
  patterns: ConversationFrictionPattern[];
  humanInterventionCount: number;
  syntheticInterventionCount: number;
  agentUncertaintyCount: number;
  overallAssessment: string;
}

export interface ConversationFrictionPromptInput {
  scope: EvolutionScope;
  task: SpaceTask;
  messages: TraceMessage[];
  confidenceThreshold: number;
}

export interface EvolutionConversationAnalysisServiceDeps {
  db: BunDatabase;
  evolutionRepo: EvolutionRepository;
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>;
  analyzeConversation?: (
    input: ConversationFrictionPromptInput
  ) => Promise<ConversationFrictionAnalysis>;
}

export interface CaptureConversationFrictionForTaskParams {
  scopeId: string;
  taskId: string;
  confidenceThreshold?: number;
}

export interface TraceRow {
  id: string;
  sessionId: string;
  messageType: string;
  sdkMessage: string;
  timestamp: string;
  origin: string | null;
}
