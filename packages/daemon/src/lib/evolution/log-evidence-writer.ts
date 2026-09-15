import type { EvidenceRef, StructuredLogEvent } from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { LogEvidenceRepository } from './log-evidence-types.ts';
import { selectEvidenceKind, summarizeLogEvent } from './log-event-classification.ts';
import { buildMetadata, numberOr } from './log-event-metadata.ts';

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export function findExistingEvidence(
  evolutionRepo: EvolutionRepository,
  scopeId: string,
  sourceId: string,
  fingerprint: string
) {
  const repo = evolutionRepo as LogEvidenceRepository;
  const candidate = repo.findLatestEvidenceBySource
    ? repo.findLatestEvidenceBySource(scopeId, sourceId)
    : repo.listEvidence(scopeId).find((evidence) => evidence.sourceId === sourceId);
  if (
    candidate?.metadata.autoCaptured === true &&
    candidate.metadata.logFingerprint === fingerprint
  ) {
    return candidate;
  }
  return undefined;
}

export function writeMatchedEvidence(
  evolutionRepo: EvolutionRepository,
  dedupeWindowMs: number | undefined,
  event: StructuredLogEvent,
  scopeId: string,
  fingerprint: string,
  existing: EvidenceRef | undefined
): void {
  const now = event.timestamp;
  const kind = selectEvidenceKind(event);
  const summary = summarizeLogEvent(event);
  if (existing) {
    const firstSeenAt = numberOr(existing.metadata.firstSeenAt, now);
    const lastSeenAt = numberOr(existing.metadata.lastSeenAt, firstSeenAt);
    if (existing.metadata.lastWriteEventId === event.id) return;
    if (now - lastSeenAt <= (dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS)) {
      evolutionRepo.updateEvidence(existing.id, {
        summary,
        metadata: buildMetadata(event, fingerprint, {
          count: numberOr(existing.metadata.count, 1) + 1,
          firstSeenAt,
          previousSamples: Array.isArray(existing.metadata.samples)
            ? existing.metadata.samples
            : [],
        }),
      });
      return;
    }
  }
  evolutionRepo.createEvidence({
    scopeId,
    kind,
    sourceId: `log:${fingerprint}`,
    summary,
    metadata: buildMetadata(event, fingerprint, {
      count: 1,
      firstSeenAt: now,
      previousSamples: [],
    }),
    createdAt: now,
  });
}
