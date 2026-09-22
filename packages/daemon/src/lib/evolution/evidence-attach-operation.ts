import type { EvidenceRef, EvolutionScope } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationPolicy,
} from '../operations/registry.ts';
import {
  admitForgeMutator,
  denyForge,
  FORGE_CALLER_REJECTIONS,
  forgeDenialSchema,
  type ForgeAdmissionDependencies,
  type ForgeAuditEntry,
  type ForgeAuditWriter,
  type ForgeGate,
  type ForgeSpaceScope,
} from './forge-admission.ts';
import { ForgeEvidenceRefSchema, ForgeMetadataSchema } from './forge-result-schemas.ts';
import type { EvolutionScopeService } from './scope-service.ts';

export interface ForgeEvidenceAttachDependencies extends ForgeAdmissionDependencies {
  readonly scopeService: Pick<
    EvolutionScopeService,
    'addManualNoteEvidence' | 'attachTaskEvidence' | 'attachWorkflowRunEvidence' | 'getScope'
  >;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  readonly workflowRunRepo: Pick<SpaceWorkflowRunRepository, 'getRun'>;
  readonly audit?: ForgeAuditWriter;
}

const EVIDENCE_ATTACH_REJECTIONS = [
  ...FORGE_CALLER_REJECTIONS,
  'scope_not_found',
  'task_not_found',
  'workflow_run_not_found',
  'evidence_not_attached',
] as const;

type EvidenceAttachRejection = (typeof EVIDENCE_ATTACH_REJECTIONS)[number];

const FORGE_MUTATE_POLICY = {
  safetyClass: 'mutate',
  roles: ['ad_hoc_member', 'long_term_agent'],
} as const satisfies OperationPolicy;

const SpaceScoped = {
  spaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Defaults to the trusted caller Space; rejects space_required when neither is set.'),
};

const ResolvableScope = {
  scopeId: z
    .string()
    .min(1)
    .optional()
    .describe('Omit to resolve the scope from the attached subject.'),
  summary: z.string().optional(),
  metadata: ForgeMetadataSchema.optional(),
};

const EvidenceAttachInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...SpaceScoped,
      kind: z.literal('manual_note'),
      scopeId: z.string().min(1),
      summary: z.string().min(1),
      metadata: ForgeMetadataSchema.optional(),
      createdAt: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      ...SpaceScoped,
      ...ResolvableScope,
      kind: z.literal('task'),
      taskId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...SpaceScoped,
      ...ResolvableScope,
      kind: z.literal('workflow_run'),
      workflowRunId: z.string().min(1),
    })
    .strict(),
]);

type EvidenceAttachInput = z.infer<typeof EvidenceAttachInputSchema>;

interface EvidenceAttachTarget extends ForgeSpaceScope {
  readonly scopeId?: string;
}

function findEvidenceScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  forge: ForgeEvidenceAttachDependencies
): EvolutionScope | null {
  const scope = forge.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireForgeEvidenceSubject(
  input: EvidenceAttachInput,
  scope: ForgeSpaceScope,
  forge: ForgeEvidenceAttachDependencies
): ForgeGate<ForgeSpaceScope, EvidenceAttachRejection> {
  if (input.kind === 'task') {
    const task = forge.taskRepo.getTask(input.taskId);
    return task && (!scope.spaceId || task.spaceId === scope.spaceId)
      ? { value: scope }
      : denyForge('task_not_found', `Task not found: ${input.taskId}`);
  }
  if (input.kind === 'workflow_run') {
    const run = forge.workflowRunRepo.getRun(input.workflowRunId);
    return run && (!scope.spaceId || run.spaceId === scope.spaceId)
      ? { value: scope }
      : denyForge('workflow_run_not_found', `Workflow run not found: ${input.workflowRunId}`);
  }
  return { value: scope };
}

export function requireForgeEvidenceTarget(
  input: EvidenceAttachInput,
  scope: ForgeSpaceScope,
  forge: ForgeEvidenceAttachDependencies
): ForgeGate<EvidenceAttachTarget, EvidenceAttachRejection> {
  if (input.scopeId && !findEvidenceScopeInSpace(input.scopeId, scope.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
  }
  return { value: { spaceId: scope.spaceId, scopeId: input.scopeId } };
}

function writeForgeEvidence(
  input: EvidenceAttachInput,
  forge: ForgeEvidenceAttachDependencies
): EvidenceRef {
  if (input.kind === 'task') {
    return forge.scopeService.attachTaskEvidence({
      taskId: input.taskId,
      scopeId: input.scopeId,
      summary: input.summary,
      metadata: input.metadata,
    });
  }
  if (input.kind === 'workflow_run') {
    return forge.scopeService.attachWorkflowRunEvidence({
      workflowRunId: input.workflowRunId,
      scopeId: input.scopeId,
      summary: input.summary,
      metadata: input.metadata,
    });
  }
  return forge.scopeService.addManualNoteEvidence({
    scopeId: input.scopeId,
    summary: input.summary,
    metadata: input.metadata,
    createdAt: input.createdAt,
  });
}

function evidenceAuditEntry(
  input: EvidenceAttachInput,
  evidence: EvidenceRef,
  target: EvidenceAttachTarget,
  caller: OperationCaller
): ForgeAuditEntry {
  const subject =
    input.kind === 'task'
      ? { taskId: input.taskId }
      : input.kind === 'workflow_run'
        ? { workflowRunId: input.workflowRunId }
        : {};
  return {
    toolName: 'evolution.evidence.attach',
    paramsSummary: { kind: input.kind, scopeId: evidence.scopeId, ...subject },
    caller,
    spaceId: target.spaceId,
    ...(input.kind === 'task' ? { taskId: input.taskId } : {}),
  };
}

export function attachForgeEvidence(
  input: EvidenceAttachInput,
  target: EvidenceAttachTarget,
  caller: OperationCaller,
  forge: ForgeEvidenceAttachDependencies
): ForgeGate<{ accepted: true; evidence: EvidenceRef }, EvidenceAttachRejection> {
  let evidence: EvidenceRef;
  try {
    evidence = writeForgeEvidence(input, forge);
  } catch (err) {
    return denyForge('evidence_not_attached', err instanceof Error ? err.message : String(err));
  }
  if (!findEvidenceScopeInSpace(evidence.scopeId, target.spaceId, forge)) {
    return denyForge('scope_not_found', `EvolutionScope not found: ${evidence.scopeId}`);
  }
  forge.audit?.(evidenceAuditEntry(input, evidence, target, caller));
  return { value: { accepted: true, evidence } };
}

export function createForgeEvidenceAttachOperation(forge: ForgeEvidenceAttachDependencies) {
  const attach = (superpipe({ forge })('forge-evidence-attach') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitForgeMutator, ['input', 'caller', 'forge'], 'result:outcome')
    .pipe(requireForgeEvidenceSubject, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(requireForgeEvidenceTarget, ['input', 'outcome', 'forge'], 'result:outcome')
    .pipe(attachForgeEvidence, ['input', 'outcome', 'caller', 'forge'], 'result:outcome')
    .endAsync('outcome');

  return defineOperation({
    name: 'evolution.evidence.attach',
    policy: FORGE_MUTATE_POLICY,
    description:
      'Attach one evidence item to a Forge scope, discriminated by kind: a manual_note on an explicit scope, a task, or a workflow_run. Task and workflow_run resolve their scope from the subject when scopeId is omitted; manual_note requires scopeId. Rejects task_not_found, workflow_run_not_found, scope_not_found, and evidence_not_attached when no scope can be resolved for the subject.',
    inputSchema: EvidenceAttachInputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), evidence: ForgeEvidenceRefSchema }),
      forgeDenialSchema(EVIDENCE_ATTACH_REJECTIONS),
    ]),
    execute: async (input, caller) => attach(input, caller),
  });
}
