import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence, NeoEvidenceRead } from '../evidence.ts';

export type NeoPackCheck = (
  item: NeoAskItem,
  evidence: readonly NeoEvidence[]
) => { value: true } | { reason: string };

export interface NeoPackBrief {
  id: string;
  describe: string;
}

export interface NeoPackFragment {
  id: string;
  instructions: string;
}

export interface NeoPack extends NeoPackBrief {
  instructions(ask: NeoAsk | null): string | null;
  readEvidence?(work: NeoWork): Promise<NeoEvidenceRead | null>;
  readAskEvidence?(ask: NeoAsk): Promise<NeoEvidence[]>;
  checks?: Record<string, NeoPackCheck>;
  workerSkills?: string[];
  workerMcpServers?: string[];
}
