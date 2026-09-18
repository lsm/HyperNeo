import {
  ARTIFACT_SHAPES,
  deriveArtifactKey,
  normalizeLinkData,
  validateArtifactShape,
} from '@hyperneo/shared';
import { z } from 'zod';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import { jsonResult, type ToolResult } from '../space/tools/tool-result.ts';

export const SaveArtifactSchema = z.object({
  shape: z
    .enum(ARTIFACT_SHAPES)
    .describe(
      "Structured shape from the closed set: 'link' | 'commit_set' | 'check' | 'metric' | 'decision' | 'note'. Required."
    ),
  kind: z
    .string()
    .min(1)
    .describe(
      "Semantic hint (freeform): 'pr', 'issue', 'preview', 'ci', 'review', etc. Used for the UI label/icon and folds into the identity key."
    )
    .optional(),
  key: z
    .string()
    .describe(
      "Identity key override. Derived from the shape by default. Pass an explicit value only for multi-instance shapes — multi-round history (decision key: 'round-0') or per-attempt audit trails (note key: 'attempt-0')."
    )
    .optional(),
  summary: z
    .string()
    .describe('Short human note (≤1 sentence). Stored as data.summary for note/decision shapes.')
    .optional(),
  data: z
    .record(z.string(), z.unknown())
    .describe(
      'Shape-specific structured payload. Required fields vary by shape (link.url, check.name+status, decision.recommendation, etc.).'
    )
    .optional(),
});

export type SaveArtifactInput = z.infer<typeof SaveArtifactSchema>;

export const ListArtifactsSchema = z.object({
  nodeId: z.string().describe('Filter by node ID').optional(),
  type: z
    .string()
    .describe('Filter by artifact shape (e.g. "link", "decision", "note")')
    .optional(),
});

export type ListArtifactsInput = z.infer<typeof ListArtifactsSchema>;

export interface NodeArtifactContext {
  readonly artifactRepo?: Pick<WorkflowRunArtifactRepository, 'upsert' | 'listByRun'>;
  readonly workflowRunId: string;
  readonly workflowNodeId: string;
  logAudit: (toolName: string, paramsSummary: Record<string, unknown>) => void;
}

export async function saveNodeArtifact(
  context: NodeArtifactContext,
  args: SaveArtifactInput
): Promise<ToolResult> {
  const { artifactRepo, workflowRunId, workflowNodeId, logAudit } = context;
  if (!artifactRepo) {
    return jsonResult({ success: false, error: 'Artifact repository not available.' });
  }

  const { shape, kind, key: keyArg, summary, data } = args;

  if (!shape) {
    return jsonResult({
      success: false,
      error: `shape is required. Known shapes: ${ARTIFACT_SHAPES.join(', ')}.`,
    });
  }

  const artifactData: Record<string, unknown> = {};
  if (summary !== undefined) artifactData.summary = summary;
  if (data !== undefined) Object.assign(artifactData, data);
  if (kind !== undefined) artifactData.kind = kind;
  const normalized = shape === 'link' ? normalizeLinkData(artifactData) : artifactData;

  if (Object.keys(normalized).length === 0) {
    return jsonResult({
      success: false,
      error: 'At least one of `summary` or `data` must be provided.',
    });
  }

  const validation = validateArtifactShape(shape, normalized);
  if (!validation.ok) {
    return jsonResult({ success: false, error: validation.error });
  }

  try {
    const artifactKey = deriveArtifactKey(shape, normalized, keyArg);

    const record = artifactRepo.upsert({
      id: crypto.randomUUID(),
      runId: workflowRunId,
      nodeId: workflowNodeId,
      artifactType: shape,
      artifactKey,
      data: normalized,
    });

    logAudit('save_artifact', {
      shape,
      kind: kind ?? undefined,
      key: artifactKey,
      summary: summary ?? undefined,
      dataKeys: data ? Object.keys(data) : undefined,
    });

    return jsonResult({
      success: true,
      artifact: {
        id: record.id,
        runId: record.runId,
        nodeId: record.nodeId,
        shape: record.artifactType,
        key: record.artifactKey,
      },
      message: `Artifact "${shape}" saved (upsert).`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ success: false, error: message });
  }
}

export async function listNodeArtifacts(
  context: NodeArtifactContext,
  args: ListArtifactsInput
): Promise<ToolResult> {
  const { artifactRepo, workflowRunId } = context;
  if (!artifactRepo) {
    return jsonResult({ success: false, error: 'Artifact repository not available.' });
  }
  try {
    const artifacts = artifactRepo.listByRun(workflowRunId, {
      nodeId: args.nodeId,
      artifactType: args.type,
    });
    return jsonResult({
      success: true,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        nodeId: a.nodeId,
        type: a.artifactType,
        key: a.artifactKey,
        data: a.data,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ success: false, error: message });
  }
}
