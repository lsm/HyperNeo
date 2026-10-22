import type { NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import type { WorkExecutionPreparation } from '../drivers/start-preparation.ts';
import type { WorkRef, WorkStatus } from '../drivers/types.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { ExternalEvent } from '../external-events/types.ts';
import type { NeoStatusLine } from './status-codes.ts';

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

export type NeoTodoJudgement =
  | { state: 'done'; evidence: string | null }
  | { state: 'failed'; reason: string }
  | { state: 'blocked'; reason: string }
  | { state: 'no_opinion' };

export interface NeoTodoFactJudge<Facts = unknown> {
  readFacts(todo: NeoTodo): Promise<Facts>;
  judge(todo: NeoTodo, facts: Facts): NeoTodoJudgement;
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
  doneWhen?(check: NeoTodoCheck): string | null;
  addUrls?(todo: NeoTodo, urls: readonly string[]): NeoTodoCheck | null;
  refuse?(
    draft: Pick<NeoTodo, 'check' | 'instruction'> & { id?: string },
    peers?: readonly NeoTodo[]
  ): string | null;
}

export type NeoPackPreferenceLabel = { en: string; 'zh-Hans': string };

export interface NeoPackPreferenceDeclaration {
  label: NeoPackPreferenceLabel;
  valueLabels: Record<string, NeoPackPreferenceLabel>;
  scope: 'global' | 'repo' | 'project';
  type:
    | { kind: 'enum'; values: readonly string[] }
    | { kind: 'boolean' }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'globs' }
    | { kind: 'login' };
  default: unknown;
  ask: string;
  askWhen?: { key: string; equals: unknown };
}

export interface NeoPack extends NeoPackBrief, Partial<NeoTodoFactJudge> {
  preferences?: Record<string, NeoPackPreferenceDeclaration>;
  todos?: NeoTodoPack;
  sweep?(now: number): Promise<void>;
  observeSessions?(sessions: readonly NeoSessionFacts[], now: number): void;
  snapshotRows?(
    repos: readonly string[] | null,
    now: number,
    openTodoIds: readonly string[]
  ): Record<string, string | number | null>[];
  workerRules?: string;
  prepareExecution?: NeoExecutionPreparation;
  instructions(): string | null;
  routeExternalEvent?(
    event: ExternalEvent,
    subscriptions: readonly NeoCardEventSubscription[]
  ): NeoPackEventRoute | null;
}

export type NeoExecutionPreparation = WorkExecutionPreparation;
