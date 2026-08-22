import superpipe, { type PipelineAPI } from 'superpipe';

export type CasOutcome = 'won' | 'superseded';

export type StagedRunUnwindEntry = {
  stage: string;
  status: 'compensated' | 'failed';
  error?: unknown;
};

export type StagedRunOutcome = {
  status: 'completed' | 'superseded' | 'error';
  result?: unknown;
  stage?: string;
  error?: unknown;
  unwind?: readonly StagedRunUnwindEntry[];
};

export type StagedRunLogEvent =
  | { event: 'stage-error'; flow: string; stage: string; error: unknown }
  | { event: 'superseded'; flow: string; stage: string }
  | { event: 'compensation-failed'; flow: string; stage: string; error: unknown };

export type StagedRunLog = (event: StagedRunLogEvent) => void;

export const DEFERRED_DURABLE_COMPENSATION_ARMS = ['durable-saga-record', 'outbox-replay'] as const;

export class StagedRunContractError extends Error {
  readonly flow: string;

  constructor(flow: string, message: string) {
    super(`stagedRun[${flow}]: ${message}`);
    this.name = 'StagedRunContractError';
    this.flow = flow;
  }
}

type MaybePromise<T> = T | Promise<T>;

type StateKey<S extends object> = keyof S & string;

type ReadKey<S extends object> = StateKey<S> | 'decision';

export type StageView<S extends object, K extends string, W extends string = never> = Pick<
  S & { decision?: unknown },
  Extract<K, keyof S | 'decision'>
> &
  Partial<Record<W, unknown>>;

export interface SnapshotStageDef<
  S extends object,
  K extends ReadKey<S> = never,
  P extends StateKey<S> = never,
  W extends string = never,
> {
  name: string;
  provides: readonly P[];
  reads?: readonly K[];
  when?: W;
  run(view: StageView<S, K, W>): MaybePromise<Partial<Pick<S, P>>>;
}

export interface DecideStageDef<
  S extends object,
  K extends ReadKey<S> = never,
  W extends string = never,
  B extends string = never,
> {
  name: string;
  reads?: readonly K[];
  branches?: readonly B[];
  when?: W;
  run(view: StageView<S, K, W>): { decision: unknown } & Partial<Record<B, unknown>>;
}

export interface EffectStageDef<
  S extends object,
  K extends ReadKey<S> = never,
  W extends string = never,
> {
  name: string;
  reads?: readonly K[];
  writes: readonly StateKey<S>[];
  when?: W;
  run(view: StageView<S, K, W>): MaybePromise<void | CasOutcome>;
  compensate?(view: StageView<S, K, W>, result: void | CasOutcome | undefined): MaybePromise<void>;
}

export interface HaltStageDef<
  S extends object,
  K extends ReadKey<S> = never,
  W extends string = never,
> {
  name: string;
  reads?: readonly K[];
  when?: W;
  run(view: StageView<S, K, W>): unknown;
}

export interface AnySnapshotStage {
  kind: 'snapshot' | 'resnapshot';
  name: string;
  provides: readonly string[];
  reads?: readonly string[];
  when?: string;
  run(view: Record<string, unknown>): unknown;
}

export interface AnyDecideStage {
  kind: 'decide';
  name: string;
  reads?: readonly string[];
  branches?: readonly string[];
  when?: string;
  run(view: Record<string, unknown>): unknown;
}

export interface AnyEffectStage {
  kind: 'effect';
  name: string;
  reads?: readonly string[];
  writes: readonly string[];
  when?: string;
  run(view: Record<string, unknown>): unknown;
  compensate?(view: Record<string, unknown>, result: unknown): MaybePromise<void>;
}

export interface AnyHaltStage {
  kind: 'halt';
  name: string;
  reads?: readonly string[];
  when?: string;
  run(view: Record<string, unknown>): unknown;
}

export type AnyStage = AnySnapshotStage | AnyDecideStage | AnyEffectStage | AnyHaltStage;

export interface StageBuilders<S extends object> {
  snapshot<K extends ReadKey<S> = never, P extends StateKey<S> = never, W extends string = never>(
    def: SnapshotStageDef<S, K, P, W>
  ): AnyStage;
  resnapshot<K extends ReadKey<S> = never, P extends StateKey<S> = never, W extends string = never>(
    def: SnapshotStageDef<S, K, P, W>
  ): AnyStage;
  decide<K extends ReadKey<S> = never, W extends string = never, B extends string = never>(
    def: DecideStageDef<S, K, W, B>
  ): AnyStage;
  effect<K extends ReadKey<S> = never, W extends string = never>(
    def: EffectStageDef<S, K, W>
  ): AnyStage;
  halt<K extends ReadKey<S> = never, W extends string = never>(
    def: HaltStageDef<S, K, W>
  ): AnyStage;
}

export interface StagedRunOptions<S extends object> {
  input?: readonly StateKey<S>[];
  log?: StagedRunLog;
}

export type StagedFlowRunner<S extends object> = (input: Partial<S>) => Promise<StagedRunOutcome>;

interface RegisteredCompensation {
  stage: string;
  compensate: (view: Record<string, unknown>, result: unknown) => MaybePromise<void>;
  view: Record<string, unknown>;
  result: unknown;
}

const RESERVED_KEYS = new Set(['decision', 'next', 'then', '__proto__', '$outcome', '$unwind']);
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emitLog(log: StagedRunLog | undefined, event: StagedRunLogEvent): void {
  if (!log) return;
  try {
    log(event);
  } catch {
    return;
  }
}

async function unwindCompensations(
  flow: string,
  stack: readonly RegisteredCompensation[],
  log?: StagedRunLog
): Promise<StagedRunUnwindEntry[]> {
  const report: StagedRunUnwindEntry[] = [];
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    try {
      await entry.compensate(entry.view, entry.result);
      report.push({ stage: entry.stage, status: 'compensated' });
    } catch (error) {
      emitLog(log, { event: 'compensation-failed', flow, stage: entry.stage, error });
      report.push({ stage: entry.stage, status: 'failed', error });
    }
  }
  return report;
}

function stripUnwind(view: Record<string, unknown>): Record<string, unknown> {
  const bodyView = { ...view };
  delete bodyView.$unwind;
  delete bodyView.next;
  return bodyView;
}

function compensationStack(view: Record<string, unknown>): RegisteredCompensation[] {
  return Array.isArray(view.$unwind) ? (view.$unwind as RegisteredCompensation[]) : [];
}

type Deliver = (merge: Record<string, unknown> | Promise<Record<string, unknown>>) => void;

function deliverViaNext(view: Record<string, unknown>): Deliver {
  const next = view.next as (error?: unknown, value?: unknown) => void;
  return (merge) => {
    if (isPromise(merge)) {
      merge.then((resolved) => next(null, resolved));
      return;
    }
    next(null, merge);
  };
}

function failureOutcome(
  flow: string,
  stage: string,
  error: unknown,
  stack: readonly RegisteredCompensation[],
  log?: StagedRunLog
): Promise<Record<string, unknown>> {
  emitLog(log, { event: 'stage-error', flow, stage, error });
  return unwindCompensations(flow, stack, log).then((unwind) => ({
    $outcome: { status: 'error', stage, error, unwind },
    $unwind: [],
  }));
}

function buildGatherAdapter(
  flow: string,
  stage: AnySnapshotStage,
  log?: StagedRunLog
): (view: Record<string, unknown>) => void {
  const provides = [...stage.provides].sort();
  return (view) => {
    const deliver = deliverViaNext(view);
    const stack = compensationStack(view);
    const bodyView = stripUnwind(view);
    const fail = (error: unknown) => failureOutcome(flow, stage.name, error, stack, log);
    const apply = (
      gathered: unknown
    ): Record<string, unknown> | Promise<Record<string, unknown>> => {
      if (!isPlainObject(gathered)) {
        return fail(new StagedRunContractError(flow, `stage ${stage.name} must return an object`));
      }
      const materialized: Record<string, unknown> = {};
      for (const key of Object.keys(gathered)) {
        materialized[key] = gathered[key];
      }
      const keys = Object.keys(materialized).sort();
      const expected = provides.join(',');
      if (keys.join(',') !== expected) {
        return fail(
          new StagedRunContractError(
            flow,
            `stage ${stage.name} must gather exactly [${expected}] but returned [${keys.join(',')}]`
          )
        );
      }
      for (const key of keys) {
        if (materialized[key] === undefined) {
          return fail(
            new StagedRunContractError(
              flow,
              `stage ${stage.name} gathered ${key} as undefined — model absence as null`
            )
          );
        }
      }
      return materialized;
    };
    try {
      const gathered = stage.run(bodyView);
      if (isPromise(gathered)) {
        gathered.then(
          (resolved) => {
            try {
              deliver(apply(resolved));
            } catch (error) {
              deliver(fail(error));
            }
          },
          (error) => deliver(fail(error))
        );
        return;
      }
      deliver(apply(gathered));
    } catch (error) {
      deliver(fail(error));
    }
  };
}

function buildDecideAdapter(
  flow: string,
  stage: AnyDecideStage,
  log?: StagedRunLog
): (view: Record<string, unknown>) => void {
  const branches = new Set(stage.branches ?? []);
  return (view) => {
    const deliver = deliverViaNext(view);
    const stack = compensationStack(view);
    const bodyView = stripUnwind(view);
    const fail = (error: unknown) => failureOutcome(flow, stage.name, error, stack, log);
    const apply = (
      stamped: unknown
    ): Record<string, unknown> | Promise<Record<string, unknown>> => {
      if (isPromise(stamped)) {
        stamped.then(undefined, () => {});
        return fail(
          new StagedRunContractError(flow, `decide stage ${stage.name} must stay synchronous`)
        );
      }
      if (!isPlainObject(stamped)) {
        return fail(new StagedRunContractError(flow, `stage ${stage.name} must return an object`));
      }
      const materialized: Record<string, unknown> = {};
      for (const key of Object.keys(stamped)) {
        materialized[key] = stamped[key];
      }
      if (materialized.decision === undefined) {
        return fail(
          new StagedRunContractError(
            flow,
            `stage ${stage.name} must stamp a defined decision as an own enumerable property`
          )
        );
      }
      let activated = 0;
      for (const key of Object.keys(materialized)) {
        if (key === 'decision') continue;
        if (!branches.has(key)) {
          return fail(
            new StagedRunContractError(
              flow,
              `stage ${stage.name} stamped ${key} without declaring it in branches`
            )
          );
        }
        if (materialized[key] !== undefined) activated += 1;
      }
      if (activated > 1) {
        return fail(
          new StagedRunContractError(
            flow,
            `stage ${stage.name} stamped ${activated} branch payloads — a decision activates at most one branch`
          )
        );
      }
      return materialized;
    };
    try {
      deliver(apply(stage.run(bodyView)));
    } catch (error) {
      deliver(fail(error));
    }
  };
}

function buildEffectAdapter(
  flow: string,
  stage: AnyEffectStage,
  log?: StagedRunLog
): (view: Record<string, unknown>) => void {
  return (view) => {
    const deliver = deliverViaNext(view);
    const stack = compensationStack(view);
    const bodyView = stripUnwind(view);
    const entry: RegisteredCompensation | null = stage.compensate
      ? {
          stage: stage.name,
          compensate: stage.compensate,
          view: { ...bodyView },
          result: undefined,
        }
      : null;
    const registered = entry ? [...stack, entry] : stack;
    const fail = (error: unknown) => failureOutcome(flow, stage.name, error, registered, log);
    const apply = (result: unknown): Record<string, unknown> | Promise<Record<string, unknown>> => {
      if (result !== undefined && result !== 'won' && result !== 'superseded') {
        return fail(
          new StagedRunContractError(
            flow,
            `effect stage ${stage.name} must return void or a CAS outcome, got ${String(result)}`
          )
        );
      }
      if (entry) entry.result = result;
      if (result === 'superseded') {
        emitLog(log, { event: 'superseded', flow, stage: stage.name });
        return unwindCompensations(flow, registered, log).then((unwind) => ({
          $outcome: { status: 'superseded', stage: stage.name, unwind },
          $unwind: [],
        }));
      }
      return { $unwind: registered };
    };
    try {
      const result = stage.run(bodyView);
      if (isPromise(result)) {
        result.then(
          (resolved) => {
            try {
              deliver(apply(resolved));
            } catch (error) {
              deliver(fail(error));
            }
          },
          (error) => deliver(fail(error))
        );
        return;
      }
      deliver(apply(result));
    } catch (error) {
      deliver(fail(error));
    }
  };
}

function buildHaltAdapter(
  flow: string,
  stage: AnyHaltStage,
  log?: StagedRunLog
): (view: Record<string, unknown>) => void {
  return (view) => {
    const deliver = deliverViaNext(view);
    const stack = compensationStack(view);
    const bodyView = stripUnwind(view);
    const fail = (error: unknown) => failureOutcome(flow, stage.name, error, stack, log);
    const apply = (result: unknown): Record<string, unknown> | Promise<Record<string, unknown>> => {
      if (isPromise(result)) {
        return result.then(
          (value) => ({ $outcome: { status: 'completed', result: value } }),
          (error) => fail(error) as Promise<Record<string, unknown>>
        );
      }
      return { $outcome: { status: 'completed', result } };
    };
    try {
      const result = stage.run(bodyView);
      deliver(apply(result));
    } catch (error) {
      deliver(fail(error));
    }
  };
}

function validateKeyShape(flow: string, key: string, label: string): void {
  if (!KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
    throw new StagedRunContractError(flow, `${label} key "${key}" is reserved or ill-formed`);
  }
}

function validateStageContract(
  flow: string,
  inputKeys: readonly string[],
  stages: readonly AnyStage[]
): void {
  if (stages.length === 0) {
    throw new StagedRunContractError(flow, 'a staged run needs at least one stage');
  }
  const names = new Set<string>();
  for (const stage of stages) {
    if (!stage.name || names.has(stage.name)) {
      throw new StagedRunContractError(flow, `stage name "${stage.name}" is missing or duplicated`);
    }
    names.add(stage.name);
  }
  const stateKeys = new Set<string>(inputKeys);
  const branchKeys = new Set<string>();
  for (const stage of stages) {
    if (stage.kind === 'snapshot' || stage.kind === 'resnapshot') {
      if (stage.provides.length === 0) {
        throw new StagedRunContractError(flow, `stage ${stage.name} provides no keys`);
      }
      if (new Set(stage.provides).size !== stage.provides.length) {
        throw new StagedRunContractError(flow, `stage ${stage.name} provides a duplicate key`);
      }
      for (const key of stage.provides) validateKeyShape(flow, key, 'provides');
    }
    if (stage.kind === 'decide') {
      for (const key of stage.branches ?? []) validateKeyShape(flow, key, 'branches');
    }
    if (stage.kind === 'effect') {
      for (const key of stage.writes) validateKeyShape(flow, key, 'writes');
    }
  }
  for (const stage of stages) {
    if (stage.kind === 'snapshot' || stage.kind === 'resnapshot') {
      for (const key of stage.provides) stateKeys.add(key);
    }
  }
  const branchOwner = new Map<string, string>();
  for (const stage of stages) {
    if (stage.kind !== 'decide') continue;
    for (const key of stage.branches ?? []) {
      if (stateKeys.has(key)) {
        throw new StagedRunContractError(
          flow,
          `stage ${stage.name} branches on "${key}" which collides with a state key`
        );
      }
      const owner = branchOwner.get(key);
      if (owner !== undefined) {
        throw new StagedRunContractError(
          flow,
          `stage ${stage.name} redeclares branch "${key}" already declared by "${owner}" — a later decide cannot redirect an earlier decide's branch`
        );
      }
      branchOwner.set(key, stage.name);
    }
  }
  for (const key of inputKeys) validateKeyShape(flow, key, 'input');
  const provided = new Set<string>(inputKeys);
  const conditional = new Map<string, Set<string>>();
  const availableAt = (key: string, when: string | undefined): boolean => {
    if (provided.has(key)) return true;
    const guards = conditional.get(key);
    return guards !== undefined && when !== undefined && guards.has(when);
  };
  const dirty = new Map<string, Set<string> | null>();
  let decisionSeen = false;
  let halted = false;
  for (const stage of stages) {
    if (halted) {
      throw new StagedRunContractError(
        flow,
        `stage ${stage.name} follows the unconditional halt and can never run`
      );
    }
    for (const key of stage.reads ?? []) {
      if (key === 'decision') {
        if (!decisionSeen) {
          throw new StagedRunContractError(
            flow,
            `stage ${stage.name} reads "decision" before any decide stage`
          );
        }
        continue;
      }
      const stale = dirty.get(key);
      if (stale !== undefined) {
        const freshUnderGuard = stale !== null && stage.when !== undefined && stale.has(stage.when);
        if (!freshUnderGuard) {
          throw new StagedRunContractError(
            flow,
            `stage ${stage.name} reads "${key}" after an effect wrote it — re-gather it with an unconditional snapshot/resnapshot, or one sharing this stage's guard`
          );
        }
      }
      if (!availableAt(key, stage.when)) {
        const guards = conditional.get(key);
        if (guards) {
          throw new StagedRunContractError(
            flow,
            `stage ${stage.name} reads "${key}" that is only provided under guard [${[...guards].join(', ')}] — read it from a stage with the same guard or re-gather it unconditionally`
          );
        }
        throw new StagedRunContractError(
          flow,
          `stage ${stage.name} reads "${key}" that no input or earlier stage provides`
        );
      }
    }
    if (stage.when !== undefined && !branchKeys.has(stage.when)) {
      throw new StagedRunContractError(
        flow,
        `stage ${stage.name} guards on "${stage.when}" that no earlier decide stage branches on`
      );
    }
    if (stage.kind === 'snapshot' || stage.kind === 'resnapshot') {
      for (const key of stage.provides) {
        if (stage.when === undefined) {
          provided.add(key);
          conditional.delete(key);
          dirty.delete(key);
        } else {
          if (!provided.has(key)) {
            const guards = conditional.get(key) ?? new Set<string>();
            guards.add(stage.when);
            conditional.set(key, guards);
          }
          const stale = dirty.get(key);
          if (stale === null) {
            dirty.set(key, new Set([stage.when]));
          } else if (stale !== undefined) {
            stale.add(stage.when);
          }
        }
      }
    }
    if (stage.kind === 'decide') {
      decisionSeen = true;
      for (const key of stage.branches ?? []) branchKeys.add(key);
    }
    if (stage.kind === 'effect') {
      for (const key of stage.writes) {
        if (!availableAt(key, stage.when)) {
          throw new StagedRunContractError(
            flow,
            `effect stage ${stage.name} writes "${key}" before any stage provides it`
          );
        }
        dirty.set(key, null);
      }
    }
    if (stage.kind === 'halt' && stage.when === undefined) halted = true;
  }
}

export function stagedRun<S extends object>(
  name: string,
  build: (s: StageBuilders<S>) => readonly AnyStage[],
  options: StagedRunOptions<S> = {}
): StagedFlowRunner<S> {
  const inputKeys = [...(options.input ?? [])];
  const log = options.log;
  const builders: StageBuilders<S> = {
    snapshot: (def) => ({ kind: 'snapshot', ...def }) as AnyStage,
    resnapshot: (def) => ({ kind: 'resnapshot', ...def }) as AnyStage,
    decide: (def) => ({ kind: 'decide', ...def }) as AnyStage,
    effect: (def) => ({ kind: 'effect', ...def }) as AnyStage,
    halt: (def) => ({ kind: 'halt', ...def }) as AnyStage,
  };
  const stages = [...build(builders)];
  validateStageContract(name, inputKeys, stages);
  const functions: Record<string, unknown> = {
    $init: () => [] as unknown[],
    $ended: (outcome: unknown) => outcome !== undefined,
  };
  stages.forEach((stage, index) => {
    const adapter =
      stage.kind === 'decide'
        ? buildDecideAdapter(name, stage, log)
        : stage.kind === 'effect'
          ? buildEffectAdapter(name, stage, log)
          : stage.kind === 'halt'
            ? buildHaltAdapter(name, stage, log)
            : buildGatherAdapter(name, stage, log);
    functions[`$s${index}`] = adapter;
  });
  let api = superpipe(functions)(name) as PipelineAPI;
  if (inputKeys.length > 0) {
    api = api.input(`{${inputKeys.join(', ')}}`);
  }
  api = api.pipe('$init', undefined, '$unwind');
  stages.forEach((stage, index) => {
    const viewKeys = [
      'next',
      ...(stage.reads ?? []),
      ...(stage.when ? [stage.when] : []),
      '$unwind',
    ];
    api = api.pipe(stage.when ? `?$s${index}` : `$s${index}`, `{${viewKeys.join(', ')}}`, '{...}');
    if (index < stages.length - 1) {
      api = api.pipe('!$ended', '$outcome');
    }
  });
  const runAsync = api.endAsync('$outcome');
  return ((input: Record<string, unknown>) => {
    const materializedInput: Record<string, unknown> = {};
    if (inputKeys.length > 0) {
      if (input === null || typeof input !== 'object') {
        throw new StagedRunContractError(name, 'flow input must be an object');
      }
      for (const key of inputKeys) {
        if (!Object.hasOwn(input, key)) {
          throw new StagedRunContractError(name, `flow input key "${key}" is missing`);
        }
        materializedInput[key] = input[key];
        if (materializedInput[key] === undefined) {
          throw new StagedRunContractError(name, `flow input key "${key}" is missing`);
        }
      }
    }
    return runAsync(materializedInput).then(
      (outcome) =>
        (outcome as StagedRunOutcome | undefined) ?? { status: 'completed', result: undefined },
      (error: unknown) => ({ status: 'error', stage: '$pipeline', error, unwind: [] })
    );
  }) as StagedFlowRunner<S>;
}
