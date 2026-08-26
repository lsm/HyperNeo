import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { Logger } from '../logger.ts';
import { isRunningUnderBun, resolveSDKCliPath } from './sdk-cli-resolver.ts';
import { withSdkTranscriptRetention } from './sdk-transcript-retention.ts';
import { normalizeEpochMs } from './limit-error-classifier.ts';

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;

type ClassifierProviderService = Pick<
  ReturnType<typeof getProviderService>,
  | 'getAvailableProviders'
  | 'isProviderAvailable'
  | 'getCheapTierModel'
  | 'getTitleGenerationModels'
  | 'applyEnvVarsToProcessForProvider'
  | 'getEnvVarsForModel'
  | 'restoreEnvVars'
>;

export interface LlmLimitAssessment {
  resetAtMs: number | null;
  kind: 'rate_limit' | 'usage_limit' | null;
  notALimit: boolean;
  relative?: boolean;
}

export interface LimitErrorLlmClassifierDeps {
  providerService: ClassifierProviderService;
  queryForTesting?: SdkQueryFunction;
  excludeProvider?: string;
  timeoutMs?: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12 * 1000;

interface CacheEntry {
  assessment: LlmLimitAssessment | null;
  expiresAt: number;
}

const assessmentCache = new Map<string, CacheEntry>();
const inflightClassifications = new Map<string, Promise<LlmLimitAssessment | null>>();
const activeWaiters = new Map<string, number>();

function evictExpiredAssessments(now: number): void {
  for (const [key, entry] of assessmentCache) {
    if (entry.expiresAt <= now) {
      assessmentCache.delete(key);
    }
  }
}

let serializedQueue: Promise<unknown> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = serializedQueue.then(task, task);
  serializedQueue = result.catch(() => undefined);
  return result;
}

function raceWithDeadline<T>(task: Promise<T>, deadline: Promise<null>): Promise<T | null> {
  return Promise.race([task.catch(() => null), deadline]);
}

function normalizeErrorText(rawText: string): string {
  return rawText
    .trim()
    .replace(/[0-9a-f]{12,}/gi, '[id]')
    .replace(/\d{10,}/g, '[ts]')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseAssessment(payload: Record<string, unknown>): LlmLimitAssessment {
  const isLimit = payload.is_limit === true;
  const kindRaw = payload.kind;
  const kind =
    kindRaw === 'usage_limit' || kindRaw === 'rate_limit'
      ? (kindRaw as 'usage_limit' | 'rate_limit')
      : null;
  const resetRaw = payload.reset_at;
  const resetAtMs =
    typeof resetRaw === 'number' && Number.isFinite(resetRaw) ? normalizeEpochMs(resetRaw) : null;
  return {
    resetAtMs: isLimit ? resetAtMs : null,
    kind: isLimit ? kind : null,
    notALimit: !isLimit,
    relative: isLimit && payload.relative === true,
  };
}

function redactErrorText(rawText: string): string {
  return rawText
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credentials]@')
    .replace(/\b(sk|rk|pk|ghp|gho|xox)[-_][A-Za-z0-9_-]{12,}\b/g, '[key]')
    .replace(/\bBearer\s+[A-Za-z0-9._+/=-]{12,}/gi, 'Bearer [token]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]');
}

function buildPrompt(rawText: string, now: number): string {
  return `You classify LLM provider API errors so a scheduler can decide when to retry.

Current time: ${new Date(now).toISOString()}

Error text:
"""
${redactErrorText(rawText).slice(0, 1500)}
"""

Rules:
1. is_limit is true only for rate limits, usage caps, quota windows, or throttling — not for auth, payment, server, or network errors.
2. reset_at is the epoch-milliseconds instant when the limit lifts. Use an absolute timestamp in the text (assume timezone UTC+8 for Chinese text unless an explicit zone is given), or compute current time + relative delay for phrases like "retry in 2 hours". Use null when no reset time can be determined.
3. Set "relative":true when reset_at was computed from a relative delay rather than an absolute timestamp in the text; otherwise omit the field.

Reply with ONLY minified JSON, no markdown fences:
{"is_limit":true,"kind":"usage_limit","reset_at":1755800000000}
Kind is "usage_limit" for windowed caps (5-hour, daily, weekly) and "rate_limit" for transient request throttling. If it is not a limit error, reply {"is_limit":false,"kind":null,"reset_at":null}.`;
}

export class LimitErrorLlmClassifier {
  private logger: Logger;

  constructor(
    sessionId: string,
    private deps: LimitErrorLlmClassifierDeps
  ) {
    this.logger = new Logger(`LimitErrorLlmClassifier ${sessionId}`);
  }

  async classify(rawText: string, signal?: AbortSignal): Promise<LlmLimitAssessment | null> {
    if (!rawText || signal?.aborted) return null;
    const key = normalizeErrorText(rawText);
    const taskKey = `${key}|${this.deps.excludeProvider ?? ''}`;
    const now = Date.now();
    const cached = assessmentCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.assessment;
    }
    activeWaiters.set(taskKey, (activeWaiters.get(taskKey) ?? 0) + 1);
    try {
      const pending = inflightClassifications.get(taskKey);
      const task =
        pending ??
        runSerialized(() => {
          if ((activeWaiters.get(taskKey) ?? 0) <= 0) {
            inflightClassifications.delete(taskKey);
            return Promise.resolve(null);
          }
          return this.classifyUncached(rawText, Date.now());
        })
          .then((assessment) => {
            evictExpiredAssessments(Date.now());
            if (assessment && !assessment.relative) {
              assessmentCache.set(key, { assessment, expiresAt: Date.now() + CACHE_TTL_MS });
            }
            return assessment;
          })
          .finally(() => {
            inflightClassifications.delete(taskKey);
          });
      if (!pending) {
        inflightClassifications.set(taskKey, task);
      }
      return await (signal ? this.raceWithAbort(task, signal) : task);
    } finally {
      const remaining = (activeWaiters.get(taskKey) ?? 1) - 1;
      if (remaining <= 0) {
        activeWaiters.delete(taskKey);
      } else {
        activeWaiters.set(taskKey, remaining);
      }
    }
  }

  private raceWithAbort(
    task: Promise<LlmLimitAssessment | null>,
    signal: AbortSignal
  ): Promise<LlmLimitAssessment | null> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      task.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve(null);
        }
      );
    });
  }

  private async classifyUncached(rawText: string, now: number): Promise<LlmLimitAssessment | null> {
    const abortController = new AbortController();
    const abortTimer = setTimeout(
      () => abortController.abort(),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    if (typeof abortTimer === 'object' && 'unref' in abortTimer) {
      abortTimer.unref();
    }
    const deadline = new Promise<null>((resolve) => {
      if (abortController.signal.aborted) {
        resolve(null);
        return;
      }
      abortController.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    try {
      const providerId = await raceWithDeadline(this.resolveClassifierProvider(), deadline);
      if (!providerId) return null;

      const cheapFallback = await raceWithDeadline(
        this.deps.providerService.getCheapTierModel(providerId),
        deadline
      );
      if (!cheapFallback) return null;
      const models = await raceWithDeadline(
        this.deps.providerService.getTitleGenerationModels(providerId, cheapFallback),
        deadline
      );
      if (!models) return null;
      const providerService = this.deps.providerService;
      const applyTask = providerService.applyEnvVarsToProcessForProvider(
        providerId,
        models.providerModelId
      );
      let originalEnv = await raceWithDeadline(applyTask, deadline);
      if (!originalEnv) {
        applyTask.then(
          (lateEnv) => providerService.restoreEnvVars(lateEnv),
          () => {}
        );
        return null;
      }
      try {
        const providerEnvVars = await raceWithDeadline(
          providerService.getEnvVarsForModel(models.providerModelId, providerId),
          deadline
        );
        if (!providerEnvVars) return null;
        const query =
          this.deps.queryForTesting ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
        const mergedEnv = mergeProviderEnvVars(providerEnvVars as Record<string, string>);
        providerService.restoreEnvVars(originalEnv);
        originalEnv = {};
        const agentQuery = query({
          prompt: buildPrompt(rawText, now),
          options: {
            model: models.sdkModelId,
            maxTurns: 1,
            permissionMode: 'acceptEdits',
            allowDangerouslySkipPermissions: false,
            mcpServers: {},
            settingSources: [],
            tools: [],
            pathToClaudeCodeExecutable: resolveSDKCliPath(),
            executable: isRunningUnderBun() ? 'bun' : undefined,
            settings: withSdkTranscriptRetention(),
            env: mergedEnv,
            thinking:
              providerId === 'kimi'
                ? KimiProvider.resolveKimiTitleThinkingConfig(models.providerModelId)
                : { type: 'disabled' },
            abortController,
          },
        });

        let reply = '';
        for await (const message of agentQuery) {
          const assistant = message as {
            type: string;
            message?: { content?: Array<{ type: string; text?: string }> };
          };
          if (assistant.type !== 'assistant' || !assistant.message) continue;
          const text = (assistant.message.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join(' ')
            .trim();
          if (text) {
            reply = text;
            break;
          }
        }
        if (!reply) return null;
        const payload = extractJsonObject(reply);
        if (!payload) return null;
        return parseAssessment(payload);
      } finally {
        providerService.restoreEnvVars(originalEnv);
      }
    } catch (error) {
      this.logger.warn('LLM limit classification failed:', error);
      return null;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  private async resolveClassifierProvider(): Promise<string | null> {
    const providerService = this.deps.providerService;
    const available = await providerService.getAvailableProviders();
    const usable = available.filter((p) => p.id !== 'acp');
    const ordered = [
      ...usable.filter((p) => p.id !== this.deps.excludeProvider),
      ...usable.filter((p) => p.id === this.deps.excludeProvider),
    ];
    for (const candidate of ordered) {
      try {
        if (candidate.models.length === 0) continue;
        if (!(await providerService.isProviderAvailable(candidate.id))) continue;
        if (!(await providerService.getCheapTierModel(candidate.id))) continue;
        return candidate.id;
      } catch {
        continue;
      }
    }
    return null;
  }

  classifyWithTimeout(rawText: string): Promise<LlmLimitAssessment | null> {
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }
    return this.classify(rawText, controller.signal).finally(() => clearTimeout(timer));
  }
}
