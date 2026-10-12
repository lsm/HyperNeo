import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { ExternalEvent } from '../../external-events/types.ts';
import type { NeoEvidence, NeoEvidenceRead } from '../evidence.ts';

export type NeoPackCheck = (
  item: NeoAskItem,
  evidence: readonly NeoEvidence[]
) => { value: string } | { reason: string };

export interface NeoPackBrief {
  id: string;
  describe: string;
  guidance?: string;
}

export interface NeoPackFragment {
  id: string;
  instructions: string;
  inPrompt?: boolean;
}

export interface NeoPack extends NeoPackBrief {
  instructions(ask: NeoAsk | null): string | null;
  readEvidence?(work: NeoWork): Promise<NeoEvidenceRead | null>;
  reportEvidence?(work: NeoWork): NeoEvidence[];
  askCardEvidence?(ask: NeoAsk, works: readonly NeoWork[]): NeoEvidence[];
  readAskEvidence?(ask: NeoAsk): Promise<NeoEvidence[]>;
  readAskTicks?(
    ask: NeoAsk,
    works: readonly NeoWork[]
  ): Promise<{ id: string; evidence: string }[]>;
  readAskWatchTicks?(ask: NeoAsk): Promise<{ id: string; evidence: string }[]>;
  checks?: Record<string, NeoPackCheck>;
  workerMcpServers?: string[];
  cardResourcesChanged?(workId: string): void;
  externalTopics?(): string[];
  externalEvent?(event: ExternalEvent): Promise<void>;
}
