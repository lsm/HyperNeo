import superpipe, { type PipelineAPI } from 'superpipe';
import type { MessageContent } from '@hyperneo/shared';
import type { RefreshNowOutcome } from '../credentials/oauth-refresh-scheduler.ts';

export interface LoginRefreshState {
  readonly nextRefreshAt: number;
  readonly attempt: number;
  readonly lastOutcome: RefreshNowOutcome | 'none';
}

export interface LoginRecoveryFacts {
  readonly retried: boolean;
  readonly needsLoginAt: number | null;
  readonly refresh: LoginRefreshState;
}

export type LoginRecoveryPlan = 'retry' | 'refresh_pending' | 'sign_in';

export interface HeldPrompt {
  uuid: string;
  content: string | MessageContent[];
}

export function afterRefresh(outcome: RefreshNowOutcome, retried: boolean): LoginRecoveryPlan {
  if (retried) return 'sign_in';
  if (outcome === 'refreshed') return 'retry';
  if (outcome === 'transient') return 'refresh_pending';
  return 'sign_in';
}

export function mayResume(facts: Pick<LoginRecoveryFacts, 'needsLoginAt' | 'refresh'>): boolean {
  return facts.needsLoginAt === null && facts.refresh.lastOutcome !== 'transient';
}

export interface LoginRecoveryEffects {
  facts(): Promise<LoginRecoveryFacts>;
  refresh(): Promise<RefreshNowOutcome>;
}

const readFacts = (effects: LoginRecoveryEffects) => effects.facts();
const gateFresh = (facts: LoginRecoveryFacts) =>
  facts.retried ? { reason: 'sign_in' as const } : { value: facts };
const refresh = (effects: LoginRecoveryEffects) => effects.refresh();
const decide = (outcome: RefreshNowOutcome, facts: LoginRecoveryFacts) => ({
  value: afterRefresh(outcome, facts.retried),
});

export const runLoginRecovery = (superpipe({})('login-recovery') as PipelineAPI)
  .input(['effects'])
  .pipe(readFacts, 'effects', 'facts')
  .pipe(gateFresh, 'facts', 'result:plan')
  .pipe(refresh, 'effects', 'outcome')
  .pipe(decide, ['outcome', 'facts'], 'result:plan')
  .endAsync('plan') as (effects: LoginRecoveryEffects) => Promise<LoginRecoveryPlan>;

export interface LoginRecoveryTimer {
  now(): number;
  schedule(run: () => void, delayMs: number): () => void;
  hold(delayMs: number, prompt: HeldPrompt | null): Promise<void>;
  resume(prompt: HeldPrompt | null): Promise<void>;
  log(line: string): void;
}

export interface LoginRecoveryDeps {
  facts(providerId: string, retried: boolean): LoginRecoveryFacts;
  refresh(providerId: string): Promise<RefreshNowOutcome>;
  enterSignIn(providerId: string): void;
  enterTransient(providerId: string): void;
  timer: LoginRecoveryTimer;
}

export const LOGIN_HOLD_FIRST_DELAY_MS = 5 * 60_000;

export function loginHoldDelayMs(nextRefreshAt: number, now: number): number {
  return Math.max(LOGIN_HOLD_FIRST_DELAY_MS, nextRefreshAt - now);
}

export function createLoginRecovery(deps: LoginRecoveryDeps) {
  const holds = new Map<string, LoginHoldState>();
  const writes = new Map<string, number>();
  const entering = new Set<string>();

  const writeCount = (providerId: string) => writes.get(providerId) ?? 0;

  async function recover(
    providerId: string,
    prompt: HeldPrompt | null,
    retried: boolean
  ): Promise<LoginRecoveryPlan> {
    const seenWrites = writeCount(providerId);
    const written = () => writeCount(providerId) !== seenWrites;
    entering.add(providerId);
    try {
      const plan = await runLoginRecovery({
        facts: async () => deps.facts(providerId, retried),
        refresh: () => deps.refresh(providerId),
      });
      if (plan === 'retry') return plan;
      const state = startHold(providerId, prompt, plan === 'sign_in');
      if (!state.active) return plan;
      await persist(providerId, state);
      if (!state.active) return plan;
      if (written() && mayResume(deps.facts(providerId, false))) {
        stop(providerId);
        return 'retry' as const;
      }
      if (plan === 'sign_in') deps.enterSignIn(providerId);
      else deps.enterTransient(providerId);
      if (!state.active) return plan;
      armTimer(providerId, state);
      if (written() && mayResume(deps.facts(providerId, false))) await resume(providerId, state);
      return plan;
    } finally {
      entering.delete(providerId);
    }
  }

  function startHold(
    providerId: string,
    prompt: HeldPrompt | null,
    awaitingSignIn: boolean
  ): LoginHoldState {
    const existing = holds.get(providerId);
    if (existing) {
      if (prompt && !existing.prompt) existing.prompt = prompt;
      if (awaitingSignIn && !existing.awaitingSignIn) {
        existing.awaitingSignIn = true;
        existing.cancel?.();
        existing.cancel = null;
      }
      return existing;
    }
    const state: LoginHoldState = { prompt, cancel: null, active: true, awaitingSignIn };
    holds.set(providerId, state);
    return state;
  }

  async function persist(providerId: string, state: LoginHoldState): Promise<void> {
    if (!state.active) return;
    await deps.timer.hold(
      loginHoldDelayMs(deps.facts(providerId, false).refresh.nextRefreshAt, deps.timer.now()),
      state.prompt
    );
  }

  function armTimer(providerId: string, state: LoginHoldState): void {
    if (!state.active || state.awaitingSignIn) return;
    const delayMs = loginHoldDelayMs(
      deps.facts(providerId, false).refresh.nextRefreshAt,
      deps.timer.now()
    );
    state.cancel = deps.timer.schedule(
      () => void tick(providerId, state).catch((error: unknown) => stop(providerId, error)),
      delayMs
    );
  }

  async function arm(providerId: string, state: LoginHoldState): Promise<void> {
    if (!state.active) return;
    if (mayResume(deps.facts(providerId, false))) return resume(providerId, state);
    await persist(providerId, state);
    armTimer(providerId, state);
  }

  async function tick(providerId: string, state: LoginHoldState): Promise<void> {
    state.cancel = null;
    if (!state.active) return;
    if (mayResume(deps.facts(providerId, false))) return resume(providerId, state);
    const outcome = await deps.refresh(providerId);
    if (!state.active) return;
    if (outcome === 'refreshed' || mayResume(deps.facts(providerId, false)))
      return resume(providerId, state);
    if (outcome !== 'transient') {
      state.awaitingSignIn = true;
      await deps.enterSignIn(providerId);
    }
    await arm(providerId, state);
  }

  async function hold(providerId: string, prompt: HeldPrompt | null): Promise<boolean> {
    if (holds.get(providerId)?.active) return true;
    const facts = deps.facts(providerId, false);
    if (mayResume(facts)) return false;
    const state = startHold(providerId, prompt, facts.needsLoginAt !== null);
    if (state.active) await arm(providerId, state);
    return state.active;
  }

  async function maybeResume(providerId: string): Promise<boolean> {
    writes.set(providerId, writeCount(providerId) + 1);
    if (entering.has(providerId)) return false;
    const writesWhenResumed = writeCount(providerId);
    const state = holds.get(providerId);
    if (!state?.active || !mayResume(deps.facts(providerId, false))) return false;
    if (writeCount(providerId) !== writesWhenResumed) return false;
    await resume(providerId, state);
    return true;
  }

  async function resume(providerId: string, state: LoginHoldState): Promise<void> {
    const prompt = state.prompt;
    stop(providerId);
    deps.timer.log('login recovery: the provider is usable again; resuming the turn');
    await deps.timer.resume(prompt);
  }

  function stop(providerId: string, error?: unknown): void {
    const state = holds.get(providerId);
    if (!state) return;
    state.cancel?.();
    state.active = false;
    holds.delete(providerId);
    if (error !== undefined)
      deps.timer.log(`login recovery: refresh tick failed: ${String(error)}`);
  }

  function isHeld(providerId: string): boolean {
    return holds.get(providerId)?.active === true;
  }

  return { recover, hold, maybeResume, isHeld, stop };
}

interface LoginHoldState {
  prompt: HeldPrompt | null;
  cancel: (() => void) | null;
  active: boolean;
  awaitingSignIn: boolean;
}
