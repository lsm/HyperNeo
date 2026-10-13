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
  checkEvidence?: Record<string, { independent: boolean }>;
  workerMcpServers?: string[];
  externalTopics?(work: NeoWork): string[];
  routeExternalEvent?(
    event: ExternalEvent,
    subscriptions: readonly NeoCardEventSubscription[]
  ): NeoPackEventRoute | null;
}

export type NeoExecutionPreparation = (
  request: {
    directory: string;
    destination: string;
    parameters: Readonly<Record<string, unknown>>;
  },
  effects: {
    run: (
      command: readonly string[],
      directory: string
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  }
) => Promise<
  | { ok: true; value: { directory: string; release: () => Promise<void> } }
  | { ok: false; reason: string }
>;
