import type { CreateEvidenceRefParams, SpaceTask } from '@hyperneo/shared';
import type {
  ConversationFrictionAnalysis,
  ConversationFrictionPattern,
  TraceMessage,
} from './conversation-analysis-types.ts';
import { CONVERSATION_ANALYSIS_VERSION } from './conversation-analysis-types.ts';

export function buildEvidenceParams(
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

export function filterResolvedPatterns(
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

export function uniquePatternsByFingerprint(
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
