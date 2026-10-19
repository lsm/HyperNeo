import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkExecutionPreparation } from '../../drivers/start-preparation.ts';
import type { WorkRef, WorkStatus } from '../../drivers/types.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { ExternalEvent } from '../../external-events/types.ts';
import type { NeoEvidence, NeoEvidenceRead } from '../evidence.ts';
import type { NeoStatusLine } from '../status-codes.ts';

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
}

export interface NeoPackCardFacts {
  text: string;
  data: Record<string, unknown>;
}

export interface NeoSessionFacts {
  ref: WorkRef;
  status: WorkStatus;
  lastActivityAt: number;
  folder?: string;
  remotes: string[];
  branches: string[];
  linkedPrs?: { url: string; dismissed?: true; own?: true }[];
  linkedPrsWindow?: true;
  openedPrs: string[];
}

export interface NeoTodoCheckResult {
  done: boolean;
  evidence: string | null;
  failed?: string;
  blocked?: { reason: string; nextAction: string };
}

export interface NeoTodoPack {
  schema(db: Database): void;
  check(todo: NeoTodo): Promise<NeoTodoCheckResult | null>;
  statusLine(todo: NeoTodo): NeoStatusLine | null;
  topics(todo: NeoTodo): string[];
  event(event: ExternalEvent): string[];
  openedPrs?(todo: NeoTodo, urls: readonly string[]): void;
  repository?(draft: Pick<NeoTodo, 'check' | 'named'> & { id?: string }): string | null;
  waiting?(todo: NeoTodo): boolean;
}

export interface NeoPack extends NeoPackBrief {
  todos?: NeoTodoPack;
  sweep?(now: number): Promise<void>;
  observeSessions?(sessions: readonly NeoSessionFacts[], now: number): void;
  snapshotRows?(
    repos: readonly string[] | null,
    now: number
  ): Record<string, string | number | null>[];
  workerRules?: string;
  prepareExecution?: NeoExecutionPreparation;
  prerequisiteParameters?(
    items: readonly NeoAskItem[]
  ): Promise<
    { ok: true; value: Record<string, string[]> } | { ok: false; reason: string; retry: boolean }
  >;
  instructions(ask: NeoAsk | null): string | null;
  readEvidence?(work: NeoWork, changedAt?: number | null): Promise<NeoEvidenceRead | null>;
  reportEvidence?(work: NeoWork): NeoEvidence[];
  cardFacts?(workId: string, stale: boolean): NeoPackCardFacts | null;
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
