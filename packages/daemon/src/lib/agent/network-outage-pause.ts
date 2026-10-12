import type { MessageContent } from '@hyperneo/shared';

export const NETWORK_OUTAGE_NOTICE =
  "Can't reach the model provider (network). Neo continues when the connection is back";
export const NETWORK_OUTAGE_POPUP_AFTER_MS = 30 * 60 * 1000;
export const NETWORK_PROBE_EVERY_MS = 30_000;
const NETWORK_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_HOST = 'api.anthropic.com';

const NETWORK_UNREACHABLE_RE =
  /\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EAI_AGAIN)\b|getaddrinfo|\bConnection error\./;
const PROBE_HOST_RE =
  /\b(?:ENOTFOUND|EAI_AGAIN)\s+([a-z0-9.-]+)|\b(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\s+(\S+):\d+/i;

type HeldPrompt = { uuid: string; content: string | MessageContent[] };

export function isNetworkUnreachableError(text: string): boolean {
  return NETWORK_UNREACHABLE_RE.test(text);
}

export function networkProbeHost(text: string, fallback: string | null = null): string {
  const match = PROBE_HOST_RE.exec(text);
  const host = match?.[1] ?? match?.[2];
  return host && !host.includes(':') ? host : (fallback ?? DEFAULT_PROBE_HOST);
}

export function providerProbeHost(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const host = new URL(baseUrl).hostname;
    return /^(?:localhost|127\.|\[?::1\]?$|0\.0\.0\.0$)/.test(host) ? null : host;
  } catch {
    return null;
  }
}

export function planNetworkOutageTick(
  startedAt: number,
  now: number,
  popupShown: boolean
): { popup: boolean; nextProbeAt: number } {
  return {
    popup: !popupShown && now - startedAt >= NETWORK_OUTAGE_POPUP_AFTER_MS,
    nextProbeAt: now + NETWORK_PROBE_EVERY_MS,
  };
}

export async function probeNetworkHost(host: string): Promise<boolean> {
  try {
    await fetch(`https://${host}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(NETWORK_PROBE_TIMEOUT_MS),
    });
    return true;
  } catch (error) {
    const text = `${String(error)} ${String((error as { cause?: unknown })?.cause ?? '')}`;
    const name = (error as { name?: string })?.name;
    return !(isNetworkUnreachableError(text) || name === 'TimeoutError' || name === 'AbortError');
  }
}

export interface NetworkOutageDeps {
  now(): number;
  probe(host: string): Promise<boolean>;
  fallbackHost(): string | null;
  schedule(run: () => void, delayMs: number): () => void;
  isHeld(): boolean;
  hold(retryAt: number, messageId: string | undefined): Promise<void>;
  notice(text: string): Promise<void>;
  popup(errorText: string): Promise<void>;
  resume(prompt: HeldPrompt | null): Promise<void>;
  log(line: string): void;
}

export class NetworkOutagePause {
  private startedAt: number | null = null;
  private popupShown = false;
  private active = false;
  private prompt: HeldPrompt | null = null;
  private host = DEFAULT_PROBE_HOST;
  private errorText = '';
  private cancelProbe: (() => void) | null = null;

  constructor(private readonly deps: NetworkOutageDeps) {}

  isActive(): boolean {
    return this.active;
  }

  async start(errorText: string, prompt: HeldPrompt | null): Promise<void> {
    const firstFailure = this.startedAt === null;
    this.startedAt ??= this.deps.now();
    this.active = true;
    this.prompt = prompt ?? this.prompt;
    this.host = networkProbeHost(errorText, this.deps.fallbackHost());
    this.errorText = errorText;
    this.deps.log(`network outage: holding the turn and probing ${this.host}`);
    await this.holdUntil(this.deps.now() + NETWORK_PROBE_EVERY_MS);
    if (firstFailure) await this.deps.notice(NETWORK_OUTAGE_NOTICE);
  }

  async resumeNow(): Promise<boolean> {
    if (!this.active) return false;
    await this.deps.resume(this.takePrompt());
    return true;
  }

  takePrompt(): HeldPrompt | null {
    const prompt = this.prompt;
    this.stop();
    return prompt;
  }

  succeeded(): void {
    this.startedAt = null;
    this.popupShown = false;
  }

  stop(): void {
    this.cancelProbe?.();
    this.cancelProbe = null;
    this.active = false;
    this.prompt = null;
  }

  private async holdUntil(retryAt: number): Promise<void> {
    this.cancelProbe?.();
    await this.deps.hold(retryAt, this.prompt?.uuid);
    this.cancelProbe = this.deps.schedule(
      () =>
        void this.tick().catch((error: unknown) => {
          this.deps.log(`network outage: probe tick failed, dropping the pause: ${String(error)}`);
          this.stop();
        }),
      Math.max(0, retryAt - this.deps.now())
    );
  }

  private async tick(): Promise<void> {
    this.cancelProbe = null;
    if (!this.active) return;
    if (!this.deps.isHeld()) {
      this.deps.log('network outage: the session left its hold; dropping the pause');
      this.stop();
      return;
    }
    if (await this.deps.probe(this.host)) {
      if (!this.active) return;
      this.deps.log(`network outage: ${this.host} is reachable again; resuming the turn`);
      await this.deps.resume(this.takePrompt());
      return;
    }
    if (!this.active) return;
    const plan = planNetworkOutageTick(
      this.startedAt ?? this.deps.now(),
      this.deps.now(),
      this.popupShown
    );
    if (plan.popup) {
      this.popupShown = true;
      await this.deps.popup(this.errorText);
      if (!this.active) return;
    }
    await this.holdUntil(plan.nextProbeAt);
  }
}
