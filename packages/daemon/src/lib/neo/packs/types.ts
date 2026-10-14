import type { WorkExecutionPreparation } from '../../drivers/start-preparation.ts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { ExternalEvent } from '../../external-events/types.ts';
import type { NeoEvidence, NeoEvidenceRead } from '../evidence.ts';

export type NeoPackCheck = (
  item: NeoAskItem,
  evidence: readonly NeoEvidence[]
) => { value: string } | { reason: string };

export interface NeoCardEventSubscription {
  workId: string;
  topic: string;
}

export interface NeoPackEventRoute {
  workIds: string[];
  ending: NeoCardEventSubscription[];
}

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
  prepareExecution?: NeoExecutionPreparation;
  prerequisiteParameters?(
    items: readonly NeoAskItem[]
  ): Promise<{ ok: true; value: Record<string, string[]> } | { ok: false; reason: string }>;
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
  readAskEventTicks?(
    ask: NeoAsk,
    event: ExternalEvent
  ): Promise<{ id: string; evidence: string }[]>;
  askTopics?(ask: NeoAsk): string[];
  checks?: Record<string, NeoPackCheck>;
  askTickChecks?: readonly string[];
  checkEvidence?: Record<string, { independent: boolean }>;
  workerMcpServers?: string[];
  externalTopics?(work: NeoWork): string[];
  routeExternalEvent?(
    event: ExternalEvent,
    subscriptions: readonly NeoCardEventSubscription[]
  ): NeoPackEventRoute | null;
}

export type NeoExecutionPreparation = WorkExecutionPreparation;
