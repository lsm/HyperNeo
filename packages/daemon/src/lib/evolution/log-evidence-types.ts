import type { EvidenceRef, StructuredLogEvent, StructuredLogLevel } from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';

export interface LogEvidenceSubscription {
  scopeId: string;
  levels: StructuredLogLevel[];
  modules?: string[];
  patterns?: RegExp[];
}

export interface EvolutionLogEvidenceServiceDeps {
  evolutionRepo: EvolutionRepository;
  spaceRepo?: Pick<SpaceRepository, 'listSpaces'>;
  subscriptions?: LogEvidenceSubscription[];
  dedupeWindowMs?: number;
  maxBufferedEvents?: number;
  subscriptionRefreshMs?: number;
  flushDelayMs?: number;
}

export type LogEvidenceRepository = EvolutionRepository & {
  findLatestEvidenceBySource?: (scopeId: string, sourceId: string) => EvidenceRef | null;
};

export interface DrainItem {
  event: StructuredLogEvent;
  subscriptions: LogEvidenceSubscription[];
  offset: number;
}
