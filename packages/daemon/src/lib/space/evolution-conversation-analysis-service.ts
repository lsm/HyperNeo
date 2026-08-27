import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type {
  CreateEvidenceRefParams,
  EvidenceRef,
  EvolutionScope,
  SpaceTask,
} from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver.ts';
import { getAvailableModels } from '../model-service.ts';
import { Logger } from '../logger.ts';
import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';

const CONVERSATION_ANALYSIS_VERSION = 1;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const MAX_ROWS = 1000;
const PATTERN_KINDS = [
  'human_correction',
  'human_repetition',
  'agent_misunderstanding',
  'scope_creep',
  'requirement_confusion',
  'agent_apology',
  'synthetic_interruption',
] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;
const log = new Logger('EvolutionConversationAnalysisService');

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

interface TraceRow {
  id: string;
  sessionId: string;
  messageType: string;
  sdkMessage: string;
  timestamp: string;
  origin: string | null;
}

export class EvolutionConversationAnalysisService {
  constructor(private deps: EvolutionConversationAnalysisServiceDeps) {}

  async captureForTask(params: CaptureConversationFrictionForTaskParams): Promise<EvidenceRef[]> {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const scope = this.deps.evolutionRepo.getScope(params.scopeId);
    if (!scope) throw new Error(`EvolutionScope not found: ${params.scopeId}`);
    if (scope.spaceId !== task.spaceId)
      throw new Error('Task and scope must belong to the same space');

    const messages = extractConversationMessages(this.loadTraceRows(task.id));
    if (messages.length === 0) return [];

    const confidenceThreshold = normalizeConfidence(
      params.confidenceThreshold ?? readConfidenceThreshold(scope)
    );
    const analysis = await this.analyze({ scope, task, messages, confidenceThreshold });
    const patterns = filterResolvedPatterns(analysis.patterns, messages, confidenceThreshold);
    if (patterns.length === 0) return [];

    const existingByFingerprint = new Map(
      this.deps.evolutionRepo
        .listEvidence(scope.id)
        .filter(
          (item) =>
            item.kind === 'conversation_friction' &&
            item.sourceId === task.id &&
            item.metadata.conversationFrictionCaptureVersion === CONVERSATION_ANALYSIS_VERSION
        )
        .map((item) => [String(item.metadata.frictionFingerprint ?? ''), item])
    );

    return uniquePatternsByFingerprint(patterns).map((pattern) => {
      const evidenceParams = buildEvidenceParams(scope.id, task, messages, analysis, pattern, {
        confidenceThreshold,
      });
      const fingerprint = String(evidenceParams.metadata?.frictionFingerprint ?? '');
      const existing = existingByFingerprint.get(fingerprint);
      if (existing) {
        const updated = this.deps.evolutionRepo.updateEvidence(existing.id, {
          summary: evidenceParams.summary,
          metadata: evidenceParams.metadata,
        });
        existingByFingerprint.set(fingerprint, updated);
        return updated;
      }
      const created = this.deps.evolutionRepo.createEvidence(evidenceParams);
      existingByFingerprint.set(fingerprint, created);
      return created;
    });
  }

  private loadTraceRows(taskId: string): TraceRow[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, session_id, message_type, sdk_message, timestamp, origin
				 FROM (
					 SELECT id, session_id, message_type, sdk_message, timestamp, origin
					 FROM sdk_messages
					 WHERE task_id = ?
						 AND parent_tool_use_id IS NULL
						 AND COALESCE(message_subtype, '') NOT IN ('thinking_tokens', 'session_state_changed', 'commands_changed')
							 AND NOT EXISTS (
								SELECT 1
								FROM sdk_message_replacements replacement
								WHERE replacement.task_id = sdk_messages.task_id
								  AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
							 )
							 AND COALESCE(send_status, 'consumed') IN ('consumed', 'failed')
					 ORDER BY timestamp DESC, id DESC
					 LIMIT ?
				 ) recent_trace_rows
				 ORDER BY timestamp ASC, id ASC`
      )
      .all(taskId, MAX_ROWS) as Array<{
      id: string;
      session_id: string;
      message_type: string;
      sdk_message: string;
      timestamp: string;
      origin: string | null;
    }>;
    if (rows.length === MAX_ROWS) {
      log.info('Conversation friction trace rows reached MAX_ROWS; context may be truncated', {
        taskId,
        maxRows: MAX_ROWS,
      });
    }
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      messageType: row.message_type,
      sdkMessage: row.sdk_message,
      timestamp: row.timestamp,
      origin: row.origin,
    }));
  }

  private async analyze(
    input: ConversationFrictionPromptInput
  ): Promise<ConversationFrictionAnalysis> {
    if (this.deps.analyzeConversation) return this.deps.analyzeConversation(input);
    return analyzeConversationWithModel(input, this.deps.spaceRepo);
  }
}

export function extractConversationMessages(rows: TraceRow[]): TraceMessage[] {
  return rows.flatMap((row) => {
    const parsed = parseJsonRecord(row.sdkMessage);
    if (!parsed) return [];
    const content = readContent(parsed);
    if (!Array.isArray(content)) return [];
    const timestamp = Date.parse(row.timestamp);
    const messages: TraceMessage[] = [];
    for (const blockValue of content) {
      const block = asRecord(blockValue);
      if (!block) continue;
      const text = readTextBlock(block);
      if (!text) continue;
      const role = classifyBlock(row, parsed, block);
      if (!role) continue;
      messages.push({
        role,
        text,
        timestamp,
        metadata: { sessionId: row.sessionId, messageId: row.id },
      });
    }
    return messages;
  });
}

export function buildConversationFrictionPrompt(input: ConversationFrictionPromptInput): string {
  const transcript = input.messages
    .map(
      (message, index) =>
        `[${index + 1}] id=${message.metadata.messageId} role=${message.role} session=${message.metadata.sessionId}\n${message.text}`
    )
    .join('\n\n');
  return `Analyze this task conversation for conversation friction patterns that rule-based tool analysis cannot detect.

Return only JSON matching this TypeScript shape:
{
  "patterns": [{
    "kind": "human_correction" | "human_repetition" | "agent_misunderstanding" | "scope_creep" | "requirement_confusion" | "agent_apology" | "synthetic_interruption",
    "confidence": number,
    "summary": string,
    "involvedMessages": string[],
    "severity": "low" | "medium" | "high"
  }],
  "humanInterventionCount": number,
  "syntheticInterventionCount": number,
  "agentUncertaintyCount": number,
  "overallAssessment": string
}

Rules:
- Use only supplied message ids in involvedMessages.
- Focus on actionable struggle patterns, miscommunications, repeated corrections, interruptions, uncertainty, apologies, or scope drift.
- Do not report ordinary tool failures or test failures unless conversation text shows misunderstanding or friction.
- Include only patterns with confidence >= ${input.confidenceThreshold}.
- Keep summaries concise and actionable.

Task: ${input.task.title}
Task description: ${input.task.description}
Scope: ${input.scope.name} — ${input.scope.objective}

Transcript:
${transcript}`;
}

export function parseConversationFrictionJson(raw: string): ConversationFrictionAnalysis {
  const text = extractJsonText(raw.trim());
  return normalizeAnalysis(JSON.parse(text));
}

function extractJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

async function analyzeConversationWithModel(
  input: ConversationFrictionPromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<ConversationFrictionAnalysis> {
  const providerService = getProviderService();
  const { provider, modelId } = await resolveConversationFrictionModel(input, spaceRepo);
  let originalEnv = await providerService.applyEnvVarsToProcessForProvider(provider, modelId);
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { isSDKAssistantMessage } = await import('@hyperneo/shared/sdk/type-guards');
    const providerEnvVars = (await providerService.getEnvVarsForModel(modelId, provider)) as Record<
      string,
      string | undefined
    >;
    const sdkModelId = provider === 'glm' ? 'haiku' : (providerEnvVars.ANTHROPIC_MODEL ?? modelId);
    const mergedEnv = mergeProviderEnvVars(providerEnvVars);
    providerService.restoreEnvVars(originalEnv);
    originalEnv = {};
    const agentQuery = query({
      prompt: buildConversationFrictionPrompt(input),
      options: {
        model: sdkModelId,
        maxTurns: 1,
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
        mcpServers: {},
        settingSources: [],
        tools: [],
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: mergedEnv,
        thinking:
          provider === 'kimi'
            ? KimiProvider.resolveKimiTitleThinkingConfig(sdkModelId)
            : { type: 'disabled' },
      },
    });
    let raw = '';
    for await (const message of agentQuery) {
      if (isSDKAssistantMessage(message)) {
        const textBlocks = message.message.content.filter(
          (block: { type: string }) => block.type === 'text'
        ) as Array<{ text?: string }>;
        raw = textBlocks
          .map((block) => block.text ?? '')
          .join('\n')
          .trim();
        if (raw) break;
      }
    }
    if (!raw) throw new Error('Conversation friction analyzer returned no text');
    return parseConversationFrictionJson(raw);
  } finally {
    providerService.restoreEnvVars(originalEnv);
  }
}

async function resolveConversationFrictionModel(
  input: ConversationFrictionPromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<{ provider: string; modelId: string }> {
  const spaceModel = spaceRepo?.getSpace(input.scope.spaceId)?.defaultModel?.trim();
  if (spaceModel) {
    const cachedModel = findCachedModel(spaceModel);
    return {
      provider: cachedModel?.provider ?? inferProviderForModel(spaceModel),
      modelId: cachedModel?.id ?? spaceModel,
    };
  }
  const providerService = getProviderService();
  const provider = await providerService.getDefaultProvider();
  const cfg = await providerService.getTitleGenerationConfig(provider);
  if (!cfg) {
    throw new Error(`Provider ${provider} has no visible models for conversation analysis`);
  }
  return { provider, modelId: cfg.modelId };
}

function findCachedModel(modelId: string): { id: string; provider: string } | undefined {
  const models = getAvailableModels('global');
  return (
    models.find((model) => model.id === modelId) ?? models.find((model) => model.alias === modelId)
  );
}

function buildEvidenceParams(
  scopeId: string,
  task: SpaceTask,
  messages: TraceMessage[],
  analysis: ConversationFrictionAnalysis,
  pattern: ConversationFrictionPattern,
  options: { confidenceThreshold: number }
): CreateEvidenceRefParams {
  const canonicalMessageIds = canonicalizeMessageIds(pattern.involvedMessages);
  const involved = messages.filter((message) =>
    canonicalMessageIds.includes(message.metadata.messageId)
  );
  const fingerprint = patternFingerprint(pattern);
  return {
    scopeId,
    kind: 'conversation_friction',
    sourceId: task.id,
    summary: `Conversation friction (${pattern.severity}): ${pattern.summary}`,
    metadata: {
      conversationFrictionDerived: true,
      conversationFrictionCaptureVersion: CONVERSATION_ANALYSIS_VERSION,
      frictionFingerprint: fingerprint,
      taskId: task.id,
      workflowRunId: task.workflowRunId ?? null,
      confidenceThreshold: options.confidenceThreshold,
      pattern: { ...pattern, involvedMessages: canonicalMessageIds },
      humanInterventionCount: analysis.humanInterventionCount,
      syntheticInterventionCount: analysis.syntheticInterventionCount,
      agentUncertaintyCount: analysis.agentUncertaintyCount,
      overallAssessment: analysis.overallAssessment,
      rawTraceRefs: rawRefs(involved, messages),
    },
  };
}

function rawRefs(messages: TraceMessage[], allMessages: TraceMessage[]): Record<string, unknown> {
  const indices = messages
    .map((message) => allMessages.indexOf(message))
    .filter((index) => index >= 0);
  return {
    sessionIds: unique(messages.map((message) => message.metadata.sessionId)),
    messageIds: unique(messages.map((message) => message.metadata.messageId)),
    messageIndexRange:
      indices.length > 0 ? { start: Math.min(...indices), end: Math.max(...indices) } : null,
    traceSpan: {
      startMessageId: allMessages[0]?.metadata.messageId ?? null,
      endMessageId: allMessages.at(-1)?.metadata.messageId ?? null,
    },
  };
}

function classifyBlock(
  row: TraceRow,
  message: Record<string, unknown>,
  block: Record<string, unknown>
): TraceMessageRole | null {
  if (block.type === 'thinking') return 'thinking';
  if (block.type !== 'text') return null;
  if (row.messageType === 'assistant') return 'assistant';
  if (row.messageType !== 'user') return null;
  if (message.isSynthetic === true || row.origin === 'system') return 'synthetic_user';
  return 'human';
}

function filterResolvedPatterns(
  patterns: ConversationFrictionPattern[],
  messages: TraceMessage[],
  confidenceThreshold: number
): ConversationFrictionPattern[] {
  const messageIds = new Set(messages.map((message) => message.metadata.messageId));
  return patterns.filter((pattern) => {
    const involvedMessageIds = canonicalizeMessageIds(pattern.involvedMessages);
    return (
      pattern.confidence >= confidenceThreshold &&
      involvedMessageIds.length > 0 &&
      involvedMessageIds.every((messageId) => messageIds.has(messageId))
    );
  });
}

function uniquePatternsByFingerprint(
  patterns: ConversationFrictionPattern[]
): ConversationFrictionPattern[] {
  const seen = new Set<string>();
  return patterns.filter((pattern) => {
    const fingerprint = patternFingerprint(pattern);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function patternFingerprint(pattern: ConversationFrictionPattern): string {
  return `conversation_friction:${pattern.kind}:${canonicalizeMessageIds(pattern.involvedMessages).join(',')}`;
}

function canonicalizeMessageIds(messageIds: string[]): string[] {
  return unique(messageIds).sort();
}

function readTextBlock(block: Record<string, unknown>): string | null {
  const textValue = block.type === 'thinking' ? block.thinking : block.text;
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  return text.length > 0 ? text : null;
}

function readContent(message: Record<string, unknown>): unknown {
  const nested = asRecord(message.message);
  return nested?.content;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeAnalysis(value: unknown): ConversationFrictionAnalysis {
  const record = requireRecord(value, 'conversation friction analysis');
  return {
    patterns: Array.isArray(record.patterns)
      ? record.patterns.flatMap((pattern) => {
          try {
            return [normalizePattern(pattern)];
          } catch {
            return [];
          }
        })
      : [],
    humanInterventionCount: readCount(record.humanInterventionCount),
    syntheticInterventionCount: readCount(record.syntheticInterventionCount),
    agentUncertaintyCount: readCount(record.agentUncertaintyCount),
    overallAssessment:
      typeof record.overallAssessment === 'string' ? record.overallAssessment : 'No assessment',
  };
}

function normalizePattern(value: unknown): ConversationFrictionPattern {
  const record = requireRecord(value, 'conversation friction pattern');
  return {
    kind: enumValue(record.kind, PATTERN_KINDS, 'pattern.kind'),
    confidence: normalizeConfidence(record.confidence),
    summary: typeof record.summary === 'string' ? record.summary : 'Conversation friction detected',
    involvedMessages: stringArray(record.involvedMessages),
    severity: enumValue(record.severity ?? 'low', SEVERITIES, 'pattern.severity'),
  };
}

function readConfidenceThreshold(scope: EvolutionScope): number {
  return normalizeConfidence(
    scope.policy.conversationFrictionConfidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD
  );
}

function normalizeConfidence(value: unknown): number {
  const number =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_CONFIDENCE_THRESHOLD;
  return Math.max(0, Math.min(1, number));
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value === 'string' && allowed.includes(value)) return value as T[number];
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`Expected ${label} object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
