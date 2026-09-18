import { Logger } from '../logger.ts';
import type { CreateMcpAuditLogParams } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { InvokeDependencies, OperationFailure, OperationOutcome } from './invoke.ts';
import type { OperationCaller, OperationDefinition, OperationRegistry } from './registry.ts';

const log = new Logger('OperationAudit');

const REDACTED = '[redacted]';
const MAX_SUMMARY_LENGTH = 2000;

export interface OperationAuditRecord {
  readonly operation: string;
  readonly caller: OperationCaller;
  readonly outcome: OperationOutcome['kind'];
  readonly failureCode?: OperationFailure['code'];
  readonly durationMs: number;
  readonly inputSummary: string | null;
}

export type OperationAuditWriter = (record: OperationAuditRecord) => void | Promise<void>;

function stringifyAuditValue(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value ?? null);
    if (serialized === undefined) return null;
    return serialized.length > MAX_SUMMARY_LENGTH
      ? `${serialized.slice(0, MAX_SUMMARY_LENGTH)}…`
      : serialized;
  } catch {
    return REDACTED;
  }
}

export function summarizeAuditInput(
  operation: OperationDefinition | undefined,
  input: unknown
): string | null {
  if (!operation) return null;
  const redactKeys = operation.policy?.audit?.redactKeys ?? [];
  if (redactKeys.length === 0) return stringifyAuditValue(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return REDACTED;
  return stringifyAuditValue(
    Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        key,
        redactKeys.includes(key) ? REDACTED : value,
      ])
    )
  );
}

export function buildOperationAuditRecord(
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  outcome: OperationOutcome,
  durationMs: number
): OperationAuditRecord | null {
  const operation = registry.get(name);
  if (operation?.policy?.audit?.selfAudited && outcome.kind === 'completed') return null;
  return {
    operation: name,
    caller,
    outcome: outcome.kind,
    ...(outcome.kind === 'failed' ? { failureCode: outcome.code } : {}),
    durationMs,
    inputSummary: summarizeAuditInput(operation, input),
  };
}

export function toAuditLogParams(record: OperationAuditRecord): CreateMcpAuditLogParams {
  return {
    toolName: record.operation,
    sessionId: record.caller.sessionId ?? null,
    spaceId: record.caller.spaceId ?? null,
    agentName: record.caller.agentName ?? null,
    callerSource: record.caller.source,
    callerRole: record.caller.role ?? null,
    callerAgentId: record.caller.agentId ?? null,
    outcome: record.outcome,
    failureCode: record.failureCode ?? null,
    durationMs: record.durationMs,
    paramsSummary: record.inputSummary,
  };
}

export function createOperationAuditWriter(
  createEntry: (params: CreateMcpAuditLogParams) => unknown
): OperationAuditWriter {
  return (record) => {
    createEntry(toAuditLogParams(record));
  };
}

export async function auditInvocation(
  dependencies: InvokeDependencies | undefined,
  registry: OperationRegistry,
  name: string,
  input: unknown,
  caller: OperationCaller,
  invocation: OperationOutcome,
  startedAt: number
): Promise<void> {
  const write = dependencies?.audit;
  if (!write) return;
  try {
    const durationMs = Math.max(0, (dependencies.now?.() ?? Date.now()) - startedAt);
    const record = buildOperationAuditRecord(registry, name, input, caller, invocation, durationMs);
    if (record) await write(record);
  } catch (error) {
    log.warn(`failed to audit ${name}:`, error);
  }
}
