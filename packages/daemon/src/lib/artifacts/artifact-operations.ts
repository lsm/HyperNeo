import type { Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { McpAuditLogRepository } from '../../storage/repositories/mcp-audit-log-repository.ts';
import type { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
} from '../operations/registry.ts';
import { resolveWorkflowExecution } from '../space/runtime/space-mcp-session-policy.ts';
import type { ToolResult } from '../space/tools/tool-result.ts';
import {
  ListArtifactsSchema,
  type ListArtifactsInput,
  listNodeArtifacts,
  type NodeArtifactContext,
  SaveArtifactSchema,
  type SaveArtifactInput,
  saveNodeArtifact,
} from './node-artifacts.ts';

export const ARTIFACT_CONTEXT_REJECTIONS = ['not_a_node_agent', 'node_caller_denied'] as const;

export type ArtifactContextRejection = (typeof ARTIFACT_CONTEXT_REJECTIONS)[number];

export const ArtifactContextRejectionSchema = z.enum(ARTIFACT_CONTEXT_REJECTIONS);

export interface ArtifactOperationDependencies {
  readonly nodeExecutionRepo: Pick<NodeExecutionRepository, 'getByAgentSessionId' | 'getById'>;
  readonly artifactRepo?: Pick<WorkflowRunArtifactRepository, 'upsert' | 'listByRun'>;
  readonly auditLogRepo?: Pick<McpAuditLogRepository, 'createEntry'>;
  readonly getSession: (sessionId: string) => Session | null;
}

export interface ArtifactOperationContext {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workflowRunId: string;
  readonly workflowNodeId: string;
  readonly taskId?: string;
}

export function admitArtifactCaller(
  caller: OperationCaller
): { value: string } | { reason: ArtifactContextRejection } {
  if (caller.source === 'mcp' && caller.role !== 'workflow_worker') {
    return { reason: 'node_caller_denied' };
  }
  return caller.sessionId ? { value: caller.sessionId } : { reason: 'not_a_node_agent' };
}

export function resolveArtifactContext(
  sessionId: string,
  deps: ArtifactOperationDependencies
): { value: ArtifactOperationContext } | { reason: ArtifactContextRejection } {
  const session = deps.getSession(sessionId);
  if (!session) return { reason: 'not_a_node_agent' };
  const execution = resolveWorkflowExecution(session, deps.nodeExecutionRepo);
  if (!execution) return { reason: 'not_a_node_agent' };
  return {
    value: {
      sessionId,
      agentName: execution.agentName,
      workflowRunId: execution.workflowRunId,
      workflowNodeId: execution.workflowNodeId,
      taskId: session.context?.taskId,
    },
  };
}

export function recordArtifactAudit(
  deps: ArtifactOperationDependencies,
  caller: OperationCaller,
  context: ArtifactOperationContext,
  toolName: string,
  paramsSummary: Record<string, unknown>
): void {
  if (!deps.auditLogRepo) return;
  try {
    deps.auditLogRepo.createEntry({
      agentName: context.agentName,
      sessionId: context.sessionId,
      toolName,
      paramsSummary: JSON.stringify(paramsSummary),
      spaceId: caller.spaceId,
      taskId: context.taskId,
      workflowRunId: context.workflowRunId,
    });
  } catch {}
}

const SavedArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  shape: z.string(),
  key: z.string(),
});

const SaveArtifactResultSchema = z.union([
  z.object({
    success: z.literal(true),
    artifact: SavedArtifactSchema,
    message: z.string(),
  }),
  z.object({ success: z.literal(false), error: z.string() }),
  ArtifactContextRejectionSchema,
]);

const ListedArtifactSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  type: z.string(),
  key: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ListArtifactsResultSchema = z.union([
  z.object({ success: z.literal(true), artifacts: z.array(ListedArtifactSchema) }),
  z.object({ success: z.literal(false), error: z.string() }),
  ArtifactContextRejectionSchema,
]);

type SaveArtifactResult = z.infer<typeof SaveArtifactResultSchema>;
type ListArtifactsResult = z.infer<typeof ListArtifactsResultSchema>;

function toolResultText(result: ToolResult): string | null {
  const text = result.content?.[0]?.text;
  return typeof text === 'string' ? text : null;
}

function parseToolResultJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function decodeSaveArtifactResult(result: ToolResult): SaveArtifactResult {
  const text = toolResultText(result);
  const validated = SaveArtifactResultSchema.safeParse(parseToolResultJson(text));
  return validated.success
    ? validated.data
    : { success: false, error: text ?? 'save_artifact returned an unreadable result' };
}

export function decodeListArtifactsResult(result: ToolResult): ListArtifactsResult {
  const text = toolResultText(result);
  const validated = ListArtifactsResultSchema.safeParse(parseToolResultJson(text));
  return validated.success
    ? validated.data
    : { success: false, error: text ?? 'list_artifacts returned an unreadable result' };
}

export async function runSaveArtifact(
  context: ArtifactOperationContext,
  input: SaveArtifactInput,
  caller: OperationCaller,
  deps: ArtifactOperationDependencies
): Promise<SaveArtifactResult> {
  const artifactContext: NodeArtifactContext = {
    artifactRepo: deps.artifactRepo,
    workflowRunId: context.workflowRunId,
    workflowNodeId: context.workflowNodeId,
    logAudit: (toolName, paramsSummary) =>
      recordArtifactAudit(deps, caller, context, toolName, paramsSummary),
  };
  return decodeSaveArtifactResult(await saveNodeArtifact(artifactContext, input));
}

export async function runListArtifacts(
  context: ArtifactOperationContext,
  input: ListArtifactsInput,
  deps: ArtifactOperationDependencies
): Promise<ListArtifactsResult> {
  const artifactContext: NodeArtifactContext = {
    artifactRepo: deps.artifactRepo,
    workflowRunId: context.workflowRunId,
    workflowNodeId: context.workflowNodeId,
    logAudit: () => {},
  };
  return decodeListArtifactsResult(await listNodeArtifacts(artifactContext, input));
}

const SAVE_DESCRIPTION =
  'Persist a structured fact to the workflow run artifact store as a link, commit_set, check, metric, decision, or note; saving the same shape and key again upserts it. The workflow run and node are resolved from the calling node-agent session, never from input, so a worker can only record artifacts for its own node. Rejects node_caller_denied when the caller is not a workflow worker and not_a_node_agent when no node execution backs the session.';

const LIST_DESCRIPTION =
  'List the artifacts recorded on the calling agent workflow run, optionally narrowed by nodeId or shape. The workflow run is resolved from the calling node-agent session, never from input. Rejects node_caller_denied when the caller is not a workflow worker and not_a_node_agent when no node execution backs the session.';

export function createArtifactSaveOperation(deps: ArtifactOperationDependencies) {
  const run = (superpipe({ deps })('save-artifact') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitArtifactCaller, 'caller', 'result:outcome')
    .pipe(resolveArtifactContext, ['outcome', 'deps'], 'result:outcome')
    .pipe(runSaveArtifact, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: SaveArtifactInput,
    caller: OperationCaller
  ) => Promise<SaveArtifactResult>;
  return defineOperation({
    name: 'artifact.save',
    policy: { safetyClass: 'mutate', roles: ['workflow_worker'] },
    description: SAVE_DESCRIPTION,
    inputSchema: SaveArtifactSchema,
    resultSchema: SaveArtifactResultSchema,
    execute: (input, caller) => run(input, caller),
  });
}

export function createArtifactListOperation(deps: ArtifactOperationDependencies) {
  const run = (superpipe({ deps })('list-artifacts') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitArtifactCaller, 'caller', 'result:outcome')
    .pipe(resolveArtifactContext, ['outcome', 'deps'], 'result:outcome')
    .pipe(runListArtifacts, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: ListArtifactsInput,
    caller: OperationCaller
  ) => Promise<ListArtifactsResult>;
  return defineOperation({
    name: 'artifact.list',
    policy: { safetyClass: 'read', roles: ['workflow_worker'] },
    description: LIST_DESCRIPTION,
    inputSchema: ListArtifactsSchema,
    resultSchema: ListArtifactsResultSchema,
    execute: (input, caller) => run(input, caller),
  });
}

export function createArtifactOperations(
  deps: ArtifactOperationDependencies
): OperationDefinition[] {
  return [createArtifactSaveOperation(deps), createArtifactListOperation(deps)];
}
