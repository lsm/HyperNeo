import { z } from 'zod';
import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';

const QuestionResponse = z.object({
  questionIndex: z.number(),
  selectedLabels: z.array(z.string()),
  customText: z.string().optional(),
});
const PendingQuestion = z.object({
  toolUseId: z.string(),
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
      multiSelect: z.boolean(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    })
  ),
  askedAt: z.number(),
  draftResponses: z.array(QuestionResponse).optional(),
  inputOrigin: z.object({ sessionId: z.string(), messageId: z.string() }).nullable().optional(),
});
const AgentState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('queued'), messageId: z.string() }),
  z.object({
    status: z.literal('processing'),
    messageId: z.string(),
    phase: z.enum(['initializing', 'thinking', 'streaming', 'finalizing']),
    streamingStartedAt: z.number().optional(),
    isCompacting: z.boolean().optional(),
    messageIds: z.array(z.string()).optional(),
  }),
  z.object({ status: z.literal('waiting_for_input'), pendingQuestion: PendingQuestion }),
  z.object({
    status: z.literal('rate_limit_cooldown'),
    exhaustedCycles: z.number().optional(),
    retryCount: z.number(),
    maxRetries: z.number(),
    retryAt: z.number(),
    messageId: z.string().optional(),
    manualRetry: z.boolean().optional(),
    reason: z.literal('network').optional(),
  }),
  z.object({ status: z.literal('interrupted') }),
]);
const SessionInfo = z.object({
  id: z.string(),
  title: z.string(),
  workspacePath: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  status: z.string(),
  config: z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
    thinkingLevel: z.string().optional(),
  }),
  metadata: z.object({
    pendingModelSwitch: z.object({ model: z.string(), provider: z.string() }).nullable().optional(),
  }),
});
export const SessionEventSchema = z.object({
  worker: WorkerIdentitySchema.nullable().optional(),
  sessionInfo: SessionInfo.nullable(),
  agentState: AgentState,
  commandsData: z.object({ availableCommands: z.array(z.string()) }),
  error: z
    .object({ message: z.string(), occurredAt: z.number(), details: z.unknown().optional() })
    .nullable(),
  timestamp: z.number(),
  revision: z.number().optional(),
  daemonEpoch: z.string().optional(),
  version: z.number().optional(),
});
export const SettingsEventSchema = z.object({
  settings: z.object({
    language: z.enum(['system', 'en', 'zh-Hans']).optional(),
    settingSources: z.array(z.string()),
  }),
  timestamp: z.number(),
  version: z.number().optional(),
});
