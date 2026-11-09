import type { NeoWorkGoal } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoAsk, NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import type { NeoDriverTarget, NeoTodoTarget } from './driver-work.ts';
import type { WorkExecutionPreparation } from '../drivers/start-preparation.ts';
import type { WorkRef } from '../drivers/types.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { NeoStatusLine } from './status-codes.ts';
import type { OperationDefinition } from '../operations/registry.ts';

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
  target?: NeoDriverTarget | NeoTodoTarget | null;
};
export type NeoTodoPolicyScope = {
  workerRemotes?: readonly string[];
  edit?: true;
  ask: Pick<NeoAsk, 'id'> | null;
  todo?: Pick<NeoTodo, 'id'> | null;
  start?: true;
};

export interface NeoTodoPack {
  schema(db: Database): void;
  check(todo: NeoTodo, context?: { readOnly: true }): Promise<NeoTodoCheckResult | null>;
  statusLine(todo: NeoTodo): NeoStatusLine | null;
  repository?(draft: NeoTodoRepositoryDraft, scope?: NeoTodoPolicyScope): string | null;
  waiting?(todo: NeoTodo): boolean | Promise<boolean>;
  doneWhen?(check: NeoTodoCheck): string | null;
  addUrls?(todo: NeoTodo, urls: readonly string[]): NeoTodoCheck | null;
  refuse?(
    draft: Pick<NeoTodo, 'check' | 'instruction'> & Partial<NeoTodoRepositoryDraft>,
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

export interface NeoPackPreferenceDeclaration {
  label: NeoPackPreferenceLabel;
  valueLabels: Record<string, NeoPackPreferenceLabel>;
  scope: 'global' | 'repo' | 'project';
  type:
    | { kind: 'enum'; values: readonly string[] }
    | { kind: 'boolean' }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'globs' }
    | { kind: 'repositories' }
    | { kind: 'text' }
    | { kind: 'login' };
  default: unknown;
  ask: string;
  askWhen?: { key: string; equals: unknown };
}

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

export interface NeoPack extends NeoPackBrief, Partial<NeoTodoFactJudge> {
  forgetRepositories?(repos: readonly string[]): void;
  operations?: readonly OperationDefinition[];
  preferences?: Record<string, NeoPackPreferenceDeclaration>;
  todos?: NeoTodoPack;
  tracker?: NeoTrackerAdapter;
  sweep?(now: number): Promise<void>;
  stats?(now: number): Record<string, number> | Promise<Record<string, number>>;
  snapshotRows?(
    repos: readonly string[] | null,
    now: number,
    openTodoIds: readonly string[]
  ): Record<string, string | number | null>[];
  workerRules?: string;
  workerContext?(): string | null;
  workerStartExclusions?(todo: NeoTodo): WorkerStartExclusions | Promise<WorkerStartExclusions>;
  workerStartBrief?(instruction: string, parameters?: Record<string, unknown>): string;
  workerBrief?(
    instruction: string,
    identity: {
      model: string | null;
      effort: string | null;
      harness: string;
    }
  ): string;
  workGoal?(instruction: string, goal: NeoWorkGoal | null): string;
  prepareExecution?: NeoExecutionPreparation;
  instructions(): string | null;
}

export type NeoExecutionPreparation = WorkExecutionPreparation;

export interface NeoPackRuntime {
  packs: NeoPack[];
  defaults: readonly string[];
  operations: readonly OperationDefinition[];
}
