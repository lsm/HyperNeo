import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence, NeoEvidenceRead } from '../evidence.ts';

export type NeoPackCheck = (
  item: NeoAskItem,
  evidence: readonly NeoEvidence[]
) => { value: true } | { reason: string };

export interface NeoPack {
  id: string;
  describe: string;
  instructions(ask: NeoAsk): string | null;
  readEvidence?(work: NeoWork): Promise<NeoEvidenceRead | null>;
  checks?: Record<string, NeoPackCheck>;
  workerSkills?: string[];
  workerMcpServers?: string[];
}
