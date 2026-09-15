import { createHash } from 'node:crypto';
import type { SettingSource, ThinkingLevel } from '@hyperneo/shared';

export const WORKFLOW_RUN_DEFINITION_SCHEMA_VERSION = 1 as const;

export type WorkflowRunAutonomyLevelV1 = 1 | 2 | 3 | 4 | 5;
export type WorkflowRunPermissionModeV1 = 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
export type WorkflowRunJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkflowRunJsonValue[]
  | { [key: string]: WorkflowRunJsonValue };
export type WorkflowRunJsonObject = { [key: string]: WorkflowRunJsonValue };
export interface WorkflowRunAgentDefinitionV1 {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: string;
  permissionMode?: WorkflowRunPermissionModeV1;
  mcpServers?: { name: string; include?: boolean }[];
  criticalSystemReminder_EXPERIMENTAL?: string;
}
export interface WorkflowRunWorkerRefV1 {
  nodeId: string;
  workerName: string;
}
export type WorkflowRunTargetV1 =
  | { kind: 'node'; nodeId: string }
  | ({ kind: 'worker' } & WorkflowRunWorkerRefV1)
  | { kind: 'wildcard' };
export interface WorkflowRunWorkerProvenanceV1 extends WorkflowRunWorkerRefV1 {
  sourceTemplateKey?: string;
  sourceAgentId?: string;
}
export interface WorkflowRunDefinitionProvenanceV1 {
  workflowRunId: string;
  spaceId: string;
  sourceWorkflowId: string;
  workers: WorkflowRunWorkerProvenanceV1[];
}
export type WorkflowRunMcpServerV1 =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };
export interface WorkflowRunModelPoolEntryV1 {
  model: string;
  provider: string;
  maxConcurrent: number;
  weight: number;
}
export type WorkflowRunModelPolicyV1 =
  | { kind: 'fixed'; model: string; provider: string }
  | { kind: 'pool'; entries: WorkflowRunModelPoolEntryV1[] };
export interface ResolvedWorkflowWorkerV1 {
  name: string;
  handle: string;
  displayName: string;
  description: string;
  prompt: {
    value: string;
    source:
      | 'workflow_node_custom_prompt'
      | 'workflow_node_replaced_prompt'
      | 'space_agent_custom_prompt'
      | 'empty';
    hash: string;
  };
  modelPolicy: WorkflowRunModelPolicyV1;
  thinkingLevel: ThinkingLevel | null;
  permissionMode: WorkflowRunPermissionModeV1;
  settingSources: SettingSource[];
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  features: {
    rewind: boolean;
    worktree: boolean;
    coordinator: boolean;
    archive: boolean;
    sessionInfo: boolean;
  };
  agents: Record<string, WorkflowRunAgentDefinitionV1>;
  disabledSkillIds: string[];
  extraMcpServers: Record<string, WorkflowRunMcpServerV1>;
  eventInterests: (
    | { topic: string; label?: string }
    | { topicFrom: { source: 'primaryLink'; pattern: string }; label?: string }
  )[];
  noProgressTimeoutMs: number;
  toolGuards: { matcher: string; pattern: string; decision: 'deny'; reason: string }[];
  resetContextPerTurn: boolean;
}
export interface WorkflowRunPostApprovalV1 {
  target: { kind: 'task_agent' } | ({ kind: 'worker' } & WorkflowRunWorkerRefV1);
  instructions: string;
  requirePrMerge: boolean;
}
export interface WorkflowRunNodeV1 {
  id: string;
  name: string;
  workers: ResolvedWorkflowWorkerV1[];
  postApproval?: WorkflowRunPostApprovalV1;
  transitions: {
    id: string;
    label?: string;
    target: WorkflowRunTargetV1;
    hookId?: string;
    maxCycles?: number;
  }[];
}
export type WorkflowRunBuiltInValidatorV1 =
  | 'pr_ready'
  | 'pr_merged'
  | 'review_posted'
  | 'post_approval_only'
  | 'codex_review_approved';
export type WorkflowRunHookValidatorV1 =
  | { kind: 'built_in'; id: WorkflowRunBuiltInValidatorV1 }
  | {
      kind: 'script';
      interpreter: 'bash';
      source: string;
      timeoutMs?: number;
      externalLookups?: 'github'[];
    };
export interface WorkflowRunHookV1 {
  id: string;
  enabled: boolean;
  sourceNodeId: string;
  targetNodeId?: string;
  method:
    | 'send_message'
    | 'save_artifact'
    | 'create_standalone_task'
    | 'mark_complete'
    | 'submit_for_approval'
    | 'approve_task';
  templateData?: WorkflowRunJsonObject;
  validator: WorkflowRunHookValidatorV1;
  retry?: { maxAttempts: number; delayMs: number; backoffMultiplier?: number };
  localState?: {
    defaults?: WorkflowRunJsonObject;
    recentResultRef?: { hookId: string; key: string };
  };
  authorizedCallers: { sourceNodeId: string; workerNames?: string[] }[];
  classification?: 'validation' | 'side_effect';
  order?: number;
  label?: string;
}
export interface WorkflowRunExecutableV1 {
  schemaVersion: 1;
  kind: 'executable';
  provenance: WorkflowRunDefinitionProvenanceV1;
  space: {
    backgroundContext: string;
    instructions: string;
    taskTimeoutMs: number | null;
    autonomyLevel: WorkflowRunAutonomyLevelV1;
  };
  workflow: {
    name: string;
    handle: string | null;
    description: string;
    instructions: string;
    nodes: WorkflowRunNodeV1[];
    startNodeId: string;
    endNodeId: string;
    channels: {
      id: string;
      from: WorkflowRunTargetV1;
      to: WorkflowRunTargetV1[];
      maxCycles?: number;
      label?: string;
    }[];
    hooks: WorkflowRunHookV1[];
    completionAutonomyLevel: WorkflowRunAutonomyLevelV1;
    postApproval?: WorkflowRunPostApprovalV1;
  };
}
export interface WorkflowRunHistoryOnlyV1 {
  schemaVersion: 1;
  kind: 'history_only';
  provenance: WorkflowRunDefinitionProvenanceV1;
  reason: 'source_unavailable' | 'definition_unverifiable' | 'worker_unresolvable';
}
export type WorkflowRunDefinitionV1 = WorkflowRunExecutableV1 | WorkflowRunHistoryOnlyV1;
export interface EncodedWorkflowRunDefinition {
  schemaVersion: 1;
  payload: string;
  hash: string;
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return value === undefined ? 'null' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

export function hashWorkflowRunDefinitionPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function encodeWorkflowRunDefinition(
  value: WorkflowRunDefinitionV1
): EncodedWorkflowRunDefinition {
  const payload = stableStringify(value);
  return {
    schemaVersion: WORKFLOW_RUN_DEFINITION_SCHEMA_VERSION,
    payload,
    hash: hashWorkflowRunDefinitionPayload(payload),
  };
}
