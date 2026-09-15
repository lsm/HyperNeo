import type { EvidenceRef } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import { SPACE_CONVERSATION_FRICTION_ANALYZE } from '../job-queue-constants.ts';
import type { EvolutionScopeServiceDeps } from './scope-service-types.ts';
import type { TraceEvidenceDiagnostic } from './trace-evidence-types.ts';
import {
  clearTraceDiagnosticEvidence,
  createTraceDiagnosticEvidence,
} from './scope-auto-evidence.ts';

const log = new Logger('evolution-scope-service');

type TraceCaptureDeps = Pick<
  EvolutionScopeServiceDeps,
  'evolutionRepo' | 'traceEvidenceService' | 'jobQueue'
>;

export function traceCaptureUnavailableDiagnostic(): TraceEvidenceDiagnostic {
  return {
    status: 'no_trace_rows',
    message: 'No trace evidence generated: trace capture service is not configured',
    messageCount: 0,
    toolCallCount: 0,
    failedToolCallCount: 0,
    slowToolCallCount: 0,
    evidenceCount: 0,
  };
}

export function traceCaptureErrorDiagnostic(err: unknown): TraceEvidenceDiagnostic {
  return {
    status: 'error',
    message: 'Trace evidence capture failed',
    messageCount: 0,
    toolCallCount: 0,
    failedToolCallCount: 0,
    slowToolCallCount: 0,
    evidenceCount: 0,
    error: err instanceof Error ? err.message : String(err),
  };
}

export function captureTraceEvidenceForCompletedTask(
  deps: TraceCaptureDeps,
  scopeId: string,
  taskId: string
): { evidence: EvidenceRef[]; diagnostic: TraceEvidenceDiagnostic } {
  const service = deps.traceEvidenceService;
  if (!service) return { evidence: [], diagnostic: traceCaptureUnavailableDiagnostic() };
  try {
    const result = service.captureForTaskWithDiagnostic({ scopeId, taskId });
    if (result.evidence.length === 0) {
      createTraceDiagnosticEvidence(deps.evolutionRepo, scopeId, taskId, result.diagnostic);
    } else {
      clearTraceDiagnosticEvidence(deps.evolutionRepo, scopeId, taskId, result.diagnostic);
    }
    return result;
  } catch (err) {
    const diagnostic = traceCaptureErrorDiagnostic(err);
    createTraceDiagnosticEvidence(deps.evolutionRepo, scopeId, taskId, diagnostic);
    log.warn('Trace evidence capture failed; keeping primary completion evidence:', err);
    return { evidence: [], diagnostic };
  }
}

export function enqueueConversationFrictionAnalysis(
  deps: TraceCaptureDeps,
  scopeId: string,
  taskId: string
): void {
  deps.jobQueue?.enqueueUniquePending({
    queue: SPACE_CONVERSATION_FRICTION_ANALYZE,
    payload: { scopeId, taskId },
    matchPayload: { scopeId, taskId },
    maxRetries: 3,
  });
}

export function captureFrictionDigestEvidence(
  deps: TraceCaptureDeps,
  scopeId: string,
  taskId: string
): EvidenceRef | null {
  try {
    return deps.traceEvidenceService?.buildFrictionDigest(scopeId, taskId) ?? null;
  } catch (err) {
    log.warn('Friction digest capture failed; continuing without digest evidence:', err);
    return null;
  }
}
