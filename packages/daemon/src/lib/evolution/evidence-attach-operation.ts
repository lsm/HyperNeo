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
  admitEvolutionMutator,
  denyEvolution,
  EVOLUTION_CALLER_REJECTIONS,
  evolutionDenialSchema,
  type EvolutionAdmissionDependencies,
  type EvolutionAuditEntry,
  type EvolutionAuditWriter,
  type EvolutionGate,
  type EvolutionSpaceScope,
} from './admission.ts';
import { EvolutionEvidenceRefSchema, EvolutionMetadataSchema } from './result-schemas.ts';
import type { EvolutionScopeService } from './scope-service.ts';

export interface EvolutionEvidenceAttachDependencies extends EvolutionAdmissionDependencies {
  readonly scopeService: Pick<
    EvolutionScopeService,
    'addManualNoteEvidence' | 'attachTaskEvidence' | 'attachWorkflowRunEvidence' | 'getScope'
  >;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask'>;
  readonly workflowRunRepo: Pick<SpaceWorkflowRunRepository, 'getRun'>;
  readonly audit?: EvolutionAuditWriter;
}

const EVIDENCE_ATTACH_REJECTIONS = [
  ...EVOLUTION_CALLER_REJECTIONS,
  'scope_not_found',
  'task_not_found',
  'workflow_run_not_found',
  'evidence_not_attached',
] as const;

type EvidenceAttachRejection = (typeof EVIDENCE_ATTACH_REJECTIONS)[number];

const EVOLUTION_MUTATE_POLICY = {
  safetyClass: 'mutate',
  roles: ['long_term_agent'],
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
  metadata: EvolutionMetadataSchema.optional(),
};

const EvidenceAttachInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...SpaceScoped,
      kind: z.literal('manual_note'),
      scopeId: z.string().min(1),
      summary: z.string().min(1),
      metadata: EvolutionMetadataSchema.optional(),
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

interface EvidenceAttachTarget extends EvolutionSpaceScope {
  readonly scopeId?: string;
}

function findEvidenceScopeInSpace(
  scopeId: string,
  spaceId: string | undefined,
  evolution: EvolutionEvidenceAttachDependencies
): EvolutionScope | null {
  const scope = evolution.scopeService.getScope(scopeId);
  return scope && (!spaceId || scope.spaceId === spaceId) ? scope : null;
}

export function requireEvolutionEvidenceSubject(
  input: EvidenceAttachInput,
  scope: EvolutionSpaceScope,
  evolution: EvolutionEvidenceAttachDependencies
): EvolutionGate<EvolutionSpaceScope, EvidenceAttachRejection> {
  if (input.kind === 'task') {
    const task = evolution.taskRepo.getTask(input.taskId);
    return task && (!scope.spaceId || task.spaceId === scope.spaceId)
      ? { value: scope }
      : denyEvolution('task_not_found', `Task not found: ${input.taskId}`);
  }
  if (input.kind === 'workflow_run') {
    const run = evolution.workflowRunRepo.getRun(input.workflowRunId);
    return run && (!scope.spaceId || run.spaceId === scope.spaceId)
      ? { value: scope }
      : denyEvolution('workflow_run_not_found', `Workflow run not found: ${input.workflowRunId}`);
  }
  return { value: scope };
}

export function requireEvolutionEvidenceTarget(
  input: EvidenceAttachInput,
  scope: EvolutionSpaceScope,
  evolution: EvolutionEvidenceAttachDependencies
): EvolutionGate<EvidenceAttachTarget, EvidenceAttachRejection> {
  if (input.scopeId && !findEvidenceScopeInSpace(input.scopeId, scope.spaceId, evolution)) {
    return denyEvolution('scope_not_found', `EvolutionScope not found: ${input.scopeId}`);
  }
  return { value: { spaceId: scope.spaceId, scopeId: input.scopeId } };
}

function writeEvolutionEvidence(
  input: EvidenceAttachInput,
  evolution: EvolutionEvidenceAttachDependencies
): EvidenceRef {
  if (input.kind === 'task') {
    return evolution.scopeService.attachTaskEvidence({
      taskId: input.taskId,
      scopeId: input.scopeId,
      summary: input.summary,
      metadata: input.metadata,
    });
  }
  if (input.kind === 'workflow_run') {
    return evolution.scopeService.attachWorkflowRunEvidence({
      workflowRunId: input.workflowRunId,
      scopeId: input.scopeId,
      summary: input.summary,
      metadata: input.metadata,
    });
  }
  return evolution.scopeService.addManualNoteEvidence({
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
): EvolutionAuditEntry {
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

export function attachEvolutionEvidence(
  input: EvidenceAttachInput,
  target: EvidenceAttachTarget,
  caller: OperationCaller,
  evolution: EvolutionEvidenceAttachDependencies
): EvolutionGate<{ accepted: true; evidence: EvidenceRef }, EvidenceAttachRejection> {
  let evidence: EvidenceRef;
  try {
    evidence = writeEvolutionEvidence(input, evolution);
  } catch (err) {
    return denyEvolution('evidence_not_attached', err instanceof Error ? err.message : String(err));
  }
  if (!findEvidenceScopeInSpace(evidence.scopeId, target.spaceId, evolution)) {
    return denyEvolution('scope_not_found', `EvolutionScope not found: ${evidence.scopeId}`);
  }
  evolution.audit?.(evidenceAuditEntry(input, evidence, target, caller));
  return { value: { accepted: true, evidence } };
}

export function createEvolutionEvidenceAttachOperation(
  evolution: EvolutionEvidenceAttachDependencies
) {
  const attach = (superpipe({ evolution })('evolution-evidence-attach') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitEvolutionMutator, ['input', 'caller', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionEvidenceSubject, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(requireEvolutionEvidenceTarget, ['input', 'outcome', 'evolution'], 'result:outcome')
    .pipe(attachEvolutionEvidence, ['input', 'outcome', 'caller', 'evolution'], 'result:outcome')
    .endAsync('outcome');

  return defineOperation({
    name: 'evolution.evidence.attach',
    policy: EVOLUTION_MUTATE_POLICY,
    description:
      'Attach one evidence item to an Evolution scope, discriminated by kind: a manual_note on an explicit scope, a task, or a workflow_run. Task and workflow_run resolve their scope from the subject when scopeId is omitted; manual_note requires scopeId. Rejects task_not_found, workflow_run_not_found, scope_not_found, and evidence_not_attached when no scope can be resolved for the subject.',
    inputSchema: EvidenceAttachInputSchema,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), evidence: EvolutionEvidenceRefSchema }),
      evolutionDenialSchema(EVIDENCE_ATTACH_REJECTIONS),
    ]),
    execute: async (input, caller) => attach(input, caller),
  });
}
