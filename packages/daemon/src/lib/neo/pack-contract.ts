import type { NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoAsk, NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import type { NeoDriverTarget, NeoTodoAddTarget, NeoTodoTarget } from './driver-work.ts';
import type { OperationOutcome } from '../operations/invoke.ts';
import type { WorkExecutionPreparation } from '../drivers/start-preparation.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { NeoStatusLine } from './status-codes.ts';
import type { OperationDefinition } from '../operations/registry.ts';
import type { DescribedRunner } from 'superpipe';
import type { NeoAttentionEvent, NeoAttentionKind } from './attention/decide.ts';
import type { NeoStepFacts } from './attention/owner.ts';

export interface NeoPackBrief {
  id: string;
  describe: string;
  guidance?: string;
  skill?: string;
  alwaysEnabled?: boolean;
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

export type NeoTodoRepositoryDraft = Pick<NeoTodo, 'check' | 'named'> & {
  id?: string;
  target?: NeoDriverTarget | NeoTodoAddTarget | null;
};
export type NeoTodoPolicyScope = {
  workerRemotes?: readonly string[];
  edit?: true;
  ask: Pick<NeoAsk, 'id'> | null;
  todo?: Pick<NeoTodo, 'id' | 'check'> | null;
  start?: true;
};

export type NeoTodoHoldResult =
  | { url: string; merged: true }
  | { url: string; merged: false; reason: string };

export interface NeoTodoPack {
  hold?: {
    accepts(condition: NeoTodoCheck): boolean;
    read(condition: NeoTodoCheck): Promise<NeoTodoHoldResult | null>;
  };
  schema(db: Database): void;
  writerAdd?: true;
  plan?(todo: NeoTodo): Promise<boolean>;
  check(todo: NeoTodo, context?: { readOnly: true }): Promise<NeoTodoCheckResult | null>;
  statusLine(todo: NeoTodo): NeoStatusLine | null;
  repository?(draft: NeoTodoRepositoryDraft, scope?: NeoTodoPolicyScope): string | null;
  waiting?(todos: readonly NeoTodo[]): Promise<ReadonlySet<string>>;
  parked?(todos: readonly NeoTodo[]): Promise<ReadonlySet<string>>;
  doneWhen?(check: NeoTodoCheck): string | null;
  addUrls?(todo: NeoTodo, urls: readonly string[]): NeoTodoCheck | null;
  refuse?(
    draft: Pick<NeoTodo, 'check' | 'instruction'> &
      Partial<NeoTodoRepositoryDraft> & { boundWorker?: boolean },
    peers?: readonly NeoTodo[],
    scope?: NeoTodoPolicyScope
  ): string | null;
  record?(
    draft: Pick<NeoTodo, 'check' | 'instruction'> & { id?: string },
    peers?: readonly NeoTodo[]
  ): string | null;
}

export function neoTodoRepository(
  draft: NeoTodoRepositoryDraft,
  packs: readonly { todos?: Pick<NeoTodoPack, 'repository'> }[],
  scope: NeoTodoPolicyScope
): string | null {
  return packs.map((pack) => pack.todos?.repository?.(draft, scope)).find(Boolean) ?? null;
}

export type NeoPackPreferenceLabel = { en: string; 'zh-Hans': string };

type WorkerStartExclusions = { value: readonly WorkRef[] } | { reason: string };
export type NeoWorkerTargetDecision = { value: NeoTodoTarget; note?: string } | { reason: string };

export interface NeoPackPreferenceDeclaration {
  label: NeoPackPreferenceLabel;
  question?: NeoPackPreferenceLabel;
  valueLabels: Record<string, NeoPackPreferenceLabel>;
  valueDescriptions?: Record<string, NeoPackPreferenceLabel>;
  scope: 'global' | 'repo' | 'project';
  type:
    | { kind: 'enum'; values: readonly string[] }
    | { kind: 'boolean' }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'globs' }
    | { kind: 'repositories' }
    | { kind: 'text' }
    | { kind: 'login' }
    | { kind: 'routes' }
    | { kind: 'lineRules' }
    | { kind: 'holdRules' };
  default: unknown;
  ask: string;
  askWhen?: { key: string; equals: unknown };
}

export type NeoLine = { provider: string; model: string; harness?: string; effort?: string };
export type NeoLineScope = { repo?: string; projectId?: string };
export type NeoLineRanking = {
  ranked: readonly { line: NeoLine; reason?: string }[];
  skipped: readonly { line: NeoLine; reason: string }[];
  exhausted: boolean;
};
export type NeoWorkKind = { id: string; label: NeoPackPreferenceLabel };

export type NeoTrackerOwner = { kind: 'ask' | 'todo'; ask: NeoAsk; todo?: NeoTodo };
export type NeoTrackerItem = { home: string; title: string; body: string; marker: string };
export interface NeoTrackerAdapter {
  id: string;
  enabled(owner: NeoTrackerOwner): boolean;
  home(owner: NeoTrackerOwner): string | null;
  create(item: NeoTrackerItem): Promise<{ ref: string } | { reason: string }>;
  find(marker: string, home: string): Promise<string | null>;
  link(parent: string, child: string): Promise<true | { reason: string }>;
  close(ref: string, outcome: 'completed' | 'not_planned'): Promise<true | { reason: string }>;
}

export type NeoPackOperation = OperationDefinition & {
  readonly pipelineRunner?: DescribedRunner;
};

export interface NeoPack extends NeoPackBrief, Partial<NeoTodoFactJudge> {
  forgetRepositories?(repos: readonly string[]): void;
  operations?: readonly NeoPackOperation[];
  preferences?: Record<string, NeoPackPreferenceDeclaration>;
  workKinds?: readonly NeoWorkKind[];
  rankLines?(
    kind: string,
    candidates: readonly NeoLine[],
    scope: NeoLineScope
  ): NeoLineRanking | Promise<NeoLineRanking>;
  todos?: NeoTodoPack;
  matter?(ask: Pick<NeoAsk, 'title' | 'request' | 'projectId'>): string | null;
  tracker?: NeoTrackerAdapter;
  linkExists?(url: string): Promise<boolean | null>;
  sweep?(now: number): Promise<void>;
  attention?: {
    kinds: readonly NeoAttentionKind[];
    scan?(
      now: number,
      waiting: readonly { todo: NeoTodo; facts: Pick<NeoStepFacts, 'worker'> }[]
    ): Promise<readonly NeoAttentionEvent[]>;
  };
  stats?(now: number): Record<string, number> | Promise<Record<string, number>>;
  snapshotRows?(
    repos: readonly string[] | null,
    now: number,
    openTodoIds: readonly string[]
  ): Record<string, string | number | null>[];
  workerRules?: string;
  workerContext?(): string | null;
  workerTemplate?(todo: NeoTodo): string | undefined;
  workerStartExclusions?(todo: NeoTodo): WorkerStartExclusions | Promise<WorkerStartExclusions>;
  workerTarget?(
    todo: NeoTodo,
    target: NeoTodoTarget,
    status: (ref: WorkRef) => Promise<OperationOutcome>
  ): Promise<NeoWorkerTargetDecision>;
  workerTargetRefused?(todo: NeoTodo): void | Promise<void>;
  workerStartBrief?(
    instruction: string,
    parameters?: Record<string, unknown>
  ): string | Promise<string>;
  workerBrief?(
    instruction: string,
    identity: {
      model: string | null;
      effort: string | null;
      harness: string;
    }
  ): string;
  workGoal?(instruction: string, goal: NeoWorkGoal | null): string;
  preparationPerRoundFields?: readonly string[];
  roles?: Record<string, { shareWith?: readonly string[] }>;
  prepareExecution?: NeoExecutionPreparation;
  instructions(): string | null;
}

export type NeoExecutionPreparation = WorkExecutionPreparation;

export interface NeoPackRuntime {
  packs: NeoPack[];
  defaults: readonly string[];
  operations: readonly OperationDefinition[];
}
