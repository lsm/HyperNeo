import type { EvidenceKind, EvidenceRef } from '@hyperneo/shared';
import type {
  CaptureTraceEvidenceForTaskParams,
  CaptureTraceEvidenceForTaskResult,
  EvolutionTraceEvidenceServiceDeps,
  TraceAnalysis,
  TraceEvidenceDiagnostic,
  TraceRow,
} from './trace-evidence-types.ts';
import { TRACE_CAPTURE_VERSION } from './trace-evidence-types.ts';
import { analyzeTrace, hasProcessFriction } from './trace-analysis.ts';
import { buildEvidenceParams } from './trace-evidence-params.ts';
import { buildFrictionDigestParams } from './trace-friction-digest.ts';

export type {
  CaptureTraceEvidenceForTaskParams,
  CaptureTraceEvidenceForTaskResult,
  EvolutionTraceEvidenceServiceDeps,
  TraceEvidenceDiagnostic,
} from './trace-evidence-types.ts';

const TRACE_EVIDENCE_KINDS: EvidenceKind[] = [
  'error_cluster',
  'retry_loop',
  'tool_failure',
  'test_failure',
  'permission_block',
  'slow_tool_call',
  'verification_triage',
];
const MAX_ROWS = 500;

export class EvolutionTraceEvidenceService {
  constructor(private deps: EvolutionTraceEvidenceServiceDeps) {}

  captureForTask(params: CaptureTraceEvidenceForTaskParams): EvidenceRef[] {
    return this.captureForTaskWithDiagnostic(params).evidence;
  }

  captureForTaskWithDiagnostic(
    params: CaptureTraceEvidenceForTaskParams
  ): CaptureTraceEvidenceForTaskResult {
    const task = this.deps.taskRepo.getTask(params.taskId);
    if (!task) throw new Error(`Task not found: ${params.taskId}`);
    const rows = this.loadTraceRows(task.id);
    if (rows.length === 0) {
      return {
        evidence: [],
        diagnostic: buildTraceDiagnostic('no_trace_rows', rows.length),
      };
    }

    const analysis = analyzeTrace(rows);
    if (!hasProcessFriction(analysis)) {
      return {
        evidence: [],
        diagnostic: buildTraceDiagnostic('no_friction', rows.length, analysis),
      };
    }

    const existingByFingerprint = new Map(
      this.deps.evolutionRepo
        .listEvidence(params.scopeId)
        .filter(
          (item) =>
            item.sourceId === task.id &&
            TRACE_EVIDENCE_KINDS.includes(item.kind) &&
            item.metadata.traceCaptureVersion === TRACE_CAPTURE_VERSION
        )
        .map((item) => [String(item.metadata.traceFingerprint ?? ''), item])
    );

    const evidence = buildEvidenceParams(params.scopeId, task, analysis).map((item) => {
      const fingerprint = String(item.metadata?.traceFingerprint ?? '');
      const existing = existingByFingerprint.get(fingerprint);
      if (existing) {
        return this.deps.evolutionRepo.updateEvidence(existing.id, {
          summary: item.summary,
          metadata: item.metadata,
        });
      }
      return this.deps.evolutionRepo.createEvidence(item);
    });
    return {
      evidence,
      diagnostic: buildTraceDiagnostic('generated', rows.length, analysis, evidence.length),
    };
  }

  buildFrictionDigest(scopeId: string, taskId: string): EvidenceRef | null {
    const task = this.deps.taskRepo.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const rows = this.loadTraceRows(task.id);
    if (rows.length === 0) return null;
    const analysis = analyzeTrace(rows);
    if (!hasProcessFriction(analysis)) return null;

    const params = buildFrictionDigestParams(scopeId, task, analysis);
    const existing = this.deps.evolutionRepo
      .listEvidence(scopeId)
      .find(
        (item) =>
          item.kind === 'friction_digest' &&
          item.sourceId === task.id &&
          item.metadata.frictionDigestFingerprint === params.metadata?.frictionDigestFingerprint
      );
    if (existing) {
      return this.deps.evolutionRepo.updateEvidence(existing.id, {
        summary: params.summary,
        metadata: params.metadata,
      });
    }
    return this.deps.evolutionRepo.createEvidence(params);
  }

  private loadTraceRows(taskId: string): TraceRow[] {
    const rows = this.deps.db
      .prepare(
        `SELECT id, session_id, message_type, sdk_message, timestamp, send_status
				 FROM (
					 SELECT id, session_id, message_type, sdk_message, timestamp, send_status
					 FROM sdk_messages
					 WHERE task_id = ?
						   AND COALESCE(message_subtype, '') NOT IN ('thinking_tokens', 'session_state_changed', 'commands_changed')
						   AND NOT EXISTS (
							 SELECT 1
							 FROM sdk_message_replacements replacement
							 WHERE replacement.task_id = sdk_messages.task_id
							   AND replacement.target_uuid = COALESCE(sdk_messages.sdk_uuid, sdk_messages.id)
						   )
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
      send_status: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      messageType: row.message_type,
      sdkMessage: row.sdk_message,
      timestamp: row.timestamp,
      sendStatus: row.send_status,
    }));
  }
}

function buildTraceDiagnostic(
  status: TraceEvidenceDiagnostic['status'],
  messageCount: number,
  analysis?: TraceAnalysis,
  evidenceCount = 0
): TraceEvidenceDiagnostic {
  return {
    status,
    message: traceDiagnosticMessage(status),
    messageCount,
    toolCallCount: analysis?.toolCallCount ?? 0,
    failedToolCallCount: analysis?.failedToolCallCount ?? 0,
    slowToolCallCount: analysis?.slowToolCalls.length ?? 0,
    evidenceCount,
  };
}

function traceDiagnosticMessage(status: TraceEvidenceDiagnostic['status']): string {
  if (status === 'generated') return 'Trace-derived evidence generated';
  if (status === 'no_trace_rows')
    return 'No trace evidence generated: no SDK messages found for task';
  if (status === 'no_friction') {
    return 'No trace evidence generated: task trace had no meaningful failures, retries, permission blocks, or slow operations';
  }
  return 'Trace evidence capture failed';
}
