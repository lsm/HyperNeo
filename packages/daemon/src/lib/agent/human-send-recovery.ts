import { type AgentProcessingState, createLogger, type ProcessingWaiting } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { getStreamSilenceTimeoutMs } from './stream-silence-watch.ts';

const DEFAULT_HUMAN_SEND_SILENCE_MS = 60_000;
const log = createLogger('hyperneo:daemon:human-send-recovery');
export const HUMAN_SEND_RESEND_LIMIT = 3;
export const HUMAN_SEND_GAVE_UP_NOTICE =
  "The model provider isn't answering. Your message was not lost; send it again to retry.";

export function getHumanSendSilenceMs(): number {
  const parsed = Number.parseInt(process.env.HYPERNEO_HUMAN_SEND_SILENCE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HUMAN_SEND_SILENCE_MS;
}

export interface HumanSendFacts {
  status: AgentProcessingState['status'];
  held: boolean;
  openTools: number;
  lastActivityAt: number;
  now: number;
  silenceMs: number;
  stallMs: number;
}

export function isSessionAlive(facts: HumanSendFacts): boolean {
  if (facts.status === 'waiting_for_input') return true;
  if (facts.held) return false;
  if (facts.status === 'idle' || facts.status === 'queued') return true;
  if (facts.status !== 'processing') return false;
  return facts.openTools > 0 || facts.now - facts.lastActivityAt < facts.silenceMs;
}

export const isSlowButLive = (facts: HumanSendFacts): boolean =>
  facts.status === 'processing' && !facts.held && facts.now - facts.lastActivityAt < facts.stallMs;

export type SilentSendPlan = 'answered' | 'wait' | 'resend' | 'give_up';

interface SilentSendFacts {
  status: AgentProcessingState['status'];
  held: boolean;
  openTools: number;
  lastOutputAt: number;
  lastInterruptAt: number;
  sentAt: number;
}

const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  'waiting_for_input',
  'rate_limit_cooldown',
  'interrupted',
]);

export function isQuietTurn(input: SilentSendFacts): boolean {
  return (
    !SETTLED_STATUSES.has(input.status) &&
    !input.held &&
    input.openTools === 0 &&
    input.lastOutputAt <= input.sentAt &&
    input.lastInterruptAt < input.sentAt
  );
}

export function planSilentSend(
  input: SilentSendFacts & { resends: number; reachable: boolean; now: number; stallMs: number }
): SilentSendPlan {
  if (!isQuietTurn(input)) return 'answered';
  if (input.reachable && input.now - input.sentAt < input.stallMs) return 'wait';
  return input.resends < HUMAN_SEND_RESEND_LIMIT ? 'resend' : 'give_up';
}

export type HumanSendRoute = 'deliver' | 'recovered' | 'wait';

interface RecoveryEffects {
  facts(): Promise<HumanSendFacts>;
  reachable(): Promise<boolean>;
  refresh(): Promise<void>;
  rebuild(): Promise<void>;
  wake(): Promise<void>;
}

const readFacts = (effects: RecoveryEffects) => effects.facts();
const gateNotAlive = (facts: HumanSendFacts) =>
  isSessionAlive(facts) ? { reason: 'deliver' as const } : { value: 'recover' as const };
const probe = (effects: RecoveryEffects) => effects.reachable();
const gateReachable = (reachable: boolean) =>
  reachable ? { value: 'recover' as const } : { reason: 'wait' as const };
const gateNotSlow = (facts: HumanSendFacts) =>
  isSlowButLive(facts) ? { reason: 'deliver' as const } : { value: 'recover' as const };
const refresh = (effects: RecoveryEffects) => effects.refresh();
const rebuild = (effects: RecoveryEffects) => effects.rebuild();
const wake = (effects: RecoveryEffects) => effects.wake();
const recovered = () => ({ value: 'recovered' as const });

export const runHumanSendRecovery = (superpipe({})('human-send-recovery') as PipelineAPI)
  .input(['effects'])
  .pipe(readFacts, 'effects', 'facts')
  .pipe(gateNotAlive, 'facts', 'result:route')
  .pipe(probe, 'effects', 'reachable')
  .pipe(gateReachable, 'reachable', 'result:route')
  .pipe(gateNotSlow, 'facts', 'result:route')
  .pipe(refresh, 'effects', 'refreshed')
  .pipe(rebuild, 'effects', 'rebuilt')
  .pipe(wake, 'effects', 'woken')
  .pipe(recovered, 'woken', 'result:route')
  .endAsync('route') as (effects: RecoveryEffects) => Promise<HumanSendRoute>;

export interface HumanSendSession {
  humanSendFacts(): Promise<Omit<HumanSendFacts, 'now' | 'silenceMs' | 'stallMs'>>;
  lastSdkOutputAt(): number;
  lastInterruptAt(): number;
  providerId(): string;
  providerReachable(): Promise<boolean>;
  holdForNetwork(): Promise<void>;
  resetQuery(options: {
    restartQuery: boolean;
    hardReset: boolean;
  }): Promise<{ success: boolean; error?: string }>;
  showNotice(text: string): Promise<void>;
  setWaiting(waiting: ProcessingWaiting): Promise<void>;
}

export interface HumanSendRecoveryDeps {
  getSession(sessionId: string): Promise<HumanSendSession | null>;
  refreshCredentials(providerId: string): Promise<void>;
  wakeParked(sessionId: string): Promise<void>;
  reopen(sessionId: string, messageUuid: string): Promise<boolean>;
}

export function createHumanSendRecovery(deps: HumanSendRecoveryDeps) {
  const lastSentAt = new Map<string, number>();
  const resends = new Map<string, number>();
  const silent = new Set<string>();
  const watched = new Map<string, Set<string>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const key = (sessionId: string, messageUuid: string) => `${sessionId}\0${messageUuid}`;

  async function prepare(sessionId: string): Promise<HumanSendRoute> {
    const session = await deps.getSession(sessionId);
    if (!session) return 'deliver';
    const route = await runHumanSendRecovery({
      facts: async () => {
        const facts = await session.humanSendFacts();
        const stalled = silent.delete(sessionId);
        return {
          ...facts,
          held: facts.held || stalled,
          lastActivityAt: Math.max(facts.lastActivityAt, lastSentAt.get(sessionId) ?? 0),
          now: Date.now(),
          silenceMs: getHumanSendSilenceMs(),
          stallMs: getStreamSilenceTimeoutMs(),
        };
      },
      reachable: () => session.providerReachable(),
      refresh: () => deps.refreshCredentials(session.providerId()),
      rebuild: async () => {
        await session.setWaiting('reconnecting');
        const reset = await session.resetQuery({ restartQuery: true, hardReset: true });
        if (!reset.success) throw new Error(reset.error ?? 'Session rebuild failed');
        await (await deps.getSession(sessionId))?.setWaiting('reconnecting');
      },
      wake: () => deps.wakeParked(sessionId),
    });
    if (route === 'wait') await session.holdForNetwork();
    return route;
  }

  async function checkSilence(sessionId: string, messageUuid: string, sentAt: number) {
    const id = key(sessionId, messageUuid);
    const session = await deps.getSession(sessionId);
    if (!session) {
      resends.delete(id);
      unwatch(sessionId, messageUuid);
      return;
    }
    const count = resends.get(id) ?? 0;
    const { status, held, openTools } = await session.humanSendFacts();
    const turn = {
      status,
      held,
      openTools,
      lastOutputAt: session.lastSdkOutputAt(),
      lastInterruptAt: session.lastInterruptAt(),
      sentAt,
    };
    const now = Date.now();
    const stallMs = getStreamSilenceTimeoutMs();
    const plan = planSilentSend({
      ...turn,
      resends: count,
      reachable: isQuietTurn(turn) ? await session.providerReachable() : true,
      now,
      stallMs,
    });
    if (plan === 'wait') {
      arm(sessionId, messageUuid, sentAt, sentAt + stallMs - now);
      const stillQuiet = isQuietTurn({
        ...turn,
        lastOutputAt: session.lastSdkOutputAt(),
        lastInterruptAt: session.lastInterruptAt(),
      });
      if (stillQuiet) await session.setWaiting('model');
      return;
    }
    if (plan === 'resend') {
      resends.set(id, count + 1);
      silent.add(sessionId);
      const others = [...(watched.get(sessionId) ?? [])].filter((uuid) => uuid !== messageUuid);
      const reopened = await deps.reopen(sessionId, messageUuid);
      for (const uuid of others) {
        const other = key(sessionId, uuid);
        clearTimeout(timers.get(other));
        timers.delete(other);
        unwatch(sessionId, uuid);
        resends.set(other, (resends.get(other) ?? 0) + 1);
        await deps.reopen(sessionId, uuid);
      }
      if (reopened) return;
      silent.delete(sessionId);
    }
    resends.delete(id);
    unwatch(sessionId, messageUuid);
    if (plan !== 'answered') await session.showNotice(HUMAN_SEND_GAVE_UP_NOTICE);
  }

  function unwatch(sessionId: string, messageUuid: string): void {
    const uuids = watched.get(sessionId);
    uuids?.delete(messageUuid);
    if (!uuids?.size) watched.delete(sessionId);
  }

  function arm(sessionId: string, messageUuid: string, sentAt: number, delayMs: number): void {
    const id = key(sessionId, messageUuid);
    clearTimeout(timers.get(id));
    const timer = setTimeout(() => {
      timers.delete(id);
      void checkSilence(sessionId, messageUuid, sentAt).catch((error: unknown) =>
        log.error(`Checking a silent human send failed: ${String(error)}`)
      );
    }, delayMs);
    timer.unref?.();
    timers.set(id, timer);
  }

  function watch(sessionId: string, messageUuid: string): void {
    const sentAt = Date.now();
    lastSentAt.set(sessionId, sentAt);
    watched.set(sessionId, (watched.get(sessionId) ?? new Set()).add(messageUuid));
    arm(sessionId, messageUuid, sentAt, getHumanSendSilenceMs());
  }

  function stop(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const entries of [lastSentAt, resends, watched]) entries.clear();
    silent.clear();
  }

  return { prepare, watch, stop };
}
