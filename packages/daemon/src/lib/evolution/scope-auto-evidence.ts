import type { CreateEvidenceRefParams, EvidenceRef, SpaceTask } from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { TraceEvidenceDiagnostic } from './trace-evidence-types.ts';

export function createAutoEvidenceOnce(
  evolutionRepo: EvolutionRepository,
  params: CreateEvidenceRefParams
): EvidenceRef {
  const sourceId = params.sourceId ?? null;
  const existing = evolutionRepo
    .listEvidence(params.scopeId)
    .find(
      (item) =>
        item.kind === params.kind &&
        item.sourceId === sourceId &&
        item.metadata.autoCaptured === true
    );
  const metadata = { ...params.metadata, autoCaptured: true };
  if (existing) {
    return evolutionRepo.updateEvidence(existing.id, {
      summary: params.summary,
      metadata,
    });
  }
  return evolutionRepo.createEvidence({ ...params, metadata });
}

export function createProposalOriginEvidence(
  evolutionRepo: EvolutionRepository,
  assignedScopeId: string,
  task: SpaceTask,
  params: Pick<CreateEvidenceRefParams, 'summary' | 'metadata'>
): EvidenceRef | null {
  const proposal = evolutionRepo.getTaskProposalByCreatedTaskId(task.id);
  if (!proposal || proposal.scopeId === assignedScopeId) return null;
  const originScope = evolutionRepo.getScope(proposal.scopeId);
  if (!originScope || originScope.spaceId !== task.spaceId) return null;
  return createAutoEvidenceOnce(evolutionRepo, {
    scopeId: originScope.id,
    kind: 'task_result',
    sourceId: task.id,
    summary: params.summary,
    metadata: {
      ...params.metadata,
      crossLinkedTaskId: task.id,
      originatingProposalId: proposal.id,
      assignedScopeId,
    },
  });
}

export function createTraceDiagnosticEvidence(
  evolutionRepo: EvolutionRepository,
  scopeId: string,
  taskId: string,
  diagnostic: TraceEvidenceDiagnostic
): EvidenceRef {
  return createAutoEvidenceOnce(evolutionRepo, {
    scopeId,
    kind: 'session',
    sourceId: taskId,
    summary: diagnostic.message,
    metadata: {
      traceDiagnostic: true,
      ...diagnostic,
    },
  });
}

export function clearTraceDiagnosticEvidence(
  evolutionRepo: EvolutionRepository,
  scopeId: string,
  taskId: string,
  diagnostic: TraceEvidenceDiagnostic
): void {
  const existing = evolutionRepo
    .listEvidence(scopeId)
    .find(
      (item) =>
        item.kind === 'session' &&
        item.sourceId === taskId &&
        item.metadata.autoCaptured === true &&
        item.metadata.traceDiagnostic === true
    );
  if (!existing) return;
  evolutionRepo.updateEvidence(existing.id, {
    summary: diagnostic.message,
    metadata: {
      autoCaptured: true,
      traceDiagnostic: true,
      clearedByTraceEvidence: true,
      ...diagnostic,
    },
  });
}
