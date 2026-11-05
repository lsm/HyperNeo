import { type AgentProcessingState, createLogger } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

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
}

export function isSessionAlive(facts: HumanSendFacts): boolean {
  if (facts.status === 'waiting_for_input') return true;
  if (facts.held) return false;
  if (facts.status === 'idle' || facts.status === 'queued') return true;
  if (facts.status !== 'processing') return false;
  return facts.openTools > 0 || facts.now - facts.lastActivityAt < facts.silenceMs;
}

export type SilentSendPlan = 'answered' | 'resend' | 'give_up';

export function planSilentSend(input: {
  status: AgentProcessingState['status'];
  openTools: number;
  lastOutputAt: number;
  sentAt: number;
  resends: number;
}): SilentSendPlan {
  const running = input.status === 'processing' || input.status === 'queued';
  if (!running || input.openTools > 0 || input.lastOutputAt > input.sentAt) return 'answered';
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
  .pipe(refresh, 'effects', 'refreshed')
  .pipe(rebuild, 'effects', 'rebuilt')
  .pipe(wake, 'effects', 'woken')
  .pipe(recovered, 'woken', 'result:route')
  .endAsync('route') as (effects: RecoveryEffects) => Promise<HumanSendRoute>;

export interface HumanSendSession {
  humanSendFacts(): Promise<Omit<HumanSendFacts, 'now' | 'silenceMs'>>;
  lastSdkOutputAt(): number;
  providerId(): string;
  providerReachable(): Promise<boolean>;
  holdForNetwork(): Promise<void>;
  resetQuery(options: {
    restartQuery: boolean;
    hardReset: boolean;
  }): Promise<{ success: boolean; error?: string }>;
  showNotice(text: string): Promise<void>;
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
  const timers = new Set<ReturnType<typeof setTimeout>>();
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
        };
      },
      reachable: () => session.providerReachable(),
      refresh: () => deps.refreshCredentials(session.providerId()),
      rebuild: async () => {
        const reset = await session.resetQuery({ restartQuery: true, hardReset: true });
        if (!reset.success) throw new Error(reset.error ?? 'Session rebuild failed');
      },
      wake: () => deps.wakeParked(sessionId),
    });
    if (route === 'wait') await session.holdForNetwork();
    return route;
  }

  async function checkSilence(sessionId: string, messageUuid: string, sentAt: number) {
    const session = await deps.getSession(sessionId);
    if (!session) return;
    const id = key(sessionId, messageUuid);
    const count = resends.get(id) ?? 0;
    const { status, openTools } = await session.humanSendFacts();
    const plan = planSilentSend({
      status,
      openTools,
      lastOutputAt: session.lastSdkOutputAt(),
      sentAt,
      resends: count,
    });
    if (plan === 'resend') {
      resends.set(id, count + 1);
      silent.add(sessionId);
      if (await deps.reopen(sessionId, messageUuid)) return;
      silent.delete(sessionId);
    }
    resends.delete(id);
    if (plan !== 'answered') await session.showNotice(HUMAN_SEND_GAVE_UP_NOTICE);
  }

  function watch(sessionId: string, messageUuid: string): void {
    const sentAt = Date.now();
    lastSentAt.set(sessionId, sentAt);
    const window = getHumanSendSilenceMs() * 2 ** (resends.get(key(sessionId, messageUuid)) ?? 0);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void checkSilence(sessionId, messageUuid, sentAt).catch((error: unknown) =>
        log.error(`Checking a silent human send failed: ${String(error)}`)
      );
    }, window);
    timer.unref?.();
    timers.add(timer);
  }

  function stop(): void {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return { prepare, watch, stop };
}
