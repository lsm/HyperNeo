import type { EvidenceRef } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';

export const TRACE_CAPTURE_VERSION = 1;

export interface EvolutionTraceEvidenceServiceDeps {
  db: BunDatabase;
  evolutionRepo: EvolutionRepository;
  taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
}

export interface CaptureTraceEvidenceForTaskParams {
  scopeId: string;
  taskId: string;
}

export interface TraceEvidenceDiagnostic {
  status: 'generated' | 'no_trace_rows' | 'no_friction' | 'error';
  message: string;
  messageCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  slowToolCallCount: number;
  evidenceCount: number;
  error?: string;
}

export interface CaptureTraceEvidenceForTaskResult {
  evidence: EvidenceRef[];
  diagnostic: TraceEvidenceDiagnostic;
}

export interface FrictionDigestTopPattern {
  category: string;
  count: number;
  example: string | null;
}

export interface TraceRow {
  id: string;
  sessionId: string;
  messageType: string;
  sdkMessage: string;
  timestamp: string;
  sendStatus: string | null;
}

export interface ToolUseRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  rowId: string;
  sessionId: string;
  messageIndex: number;
  timestamp: number;
}

export interface ToolResultRecord {
  toolUseId: string | null;
  hasToolUse: boolean;
  toolName: string;
  commandKey: string;
  rowId: string;
  sessionId: string;
  messageIndex: number;
  timestamp: number;
  failed: boolean;
  text: string;
  fingerprint: string;
  category: 'test' | 'verification' | 'edit' | 'tool' | 'permission';
  filePath: string | null;
}

export interface SlowToolCallRecord {
  toolUseId: string;
  toolName: string;
  commandKey: string;
  durationMs: number;
  filePath: string | null;
  rowId: string;
  sessionId: string;
}

export interface VerificationTriageRecord {
  key: string;
  command: string;
  category: ToolResultRecord['category'];
  failures: ToolResultRecord[];
  resolvedBy: ToolResultRecord | null;
  suspectedFix: string;
}

export interface TraceAnalysis {
  rows: TraceRow[];
  toolUses: ToolUseRecord[];
  toolResults: ToolResultRecord[];
  toolCallCount: number;
  failedToolCallCount: number;
  editFailures: ToolResultRecord[];
  testFailures: ToolResultRecord[];
  permissionBlocks: ToolResultRecord[];
  slowToolCalls: SlowToolCallRecord[];
  repeatedErrors: Array<{ fingerprint: string; count: number; results: ToolResultRecord[] }>;
  retryLoops: Array<{
    key: string;
    failuresBeforeSuccess: ToolResultRecord[];
    success: ToolResultRecord;
  }>;
  fileChurn: Array<{ filePath: string; editCount: number }>;
  firstPassingVerification: ToolResultRecord | null;
  verificationTriages: VerificationTriageRecord[];
}
