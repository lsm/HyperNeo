import type { EvidenceRef } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import type {
  CaptureConversationFrictionForTaskParams,
  ConversationFrictionAnalysis,
  ConversationFrictionPromptInput,
  EvolutionConversationAnalysisServiceDeps,
  TraceRow,
} from './conversation-analysis-types.ts';
import { CONVERSATION_ANALYSIS_VERSION } from './conversation-analysis-types.ts';
import { normalizeConfidence, readConfidenceThreshold } from './conversation-analysis-parsing.ts';
import { extractConversationMessages } from './conversation-message-extraction.ts';
import { analyzeConversationWithModel } from './conversation-friction-model.ts';
import {
  buildEvidenceParams,
  filterResolvedPatterns,
  uniquePatternsByFingerprint,
} from './conversation-friction-evidence.ts';

export { extractConversationMessages } from './conversation-message-extraction.ts';
export { parseConversationFrictionJson } from './conversation-analysis-parsing.ts';
export type {
  ConversationFrictionAnalysis,
  ConversationFrictionPromptInput,
  EvolutionConversationAnalysisServiceDeps,
  TraceMessage,
} from './conversation-analysis-types.ts';

const MAX_ROWS = 1000;
const log = new Logger('EvolutionConversationAnalysisService');

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
