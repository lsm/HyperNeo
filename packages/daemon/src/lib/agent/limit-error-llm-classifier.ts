import { fillPrompt, LIMIT_ERROR_CLASSIFIER_PROMPT } from '@hyperneo/prompts';
import { getProviderService } from '../provider-service.ts';
import { Logger } from '../logger.ts';
import { runOneShotModel } from './one-shot-model.ts';
import { normalizeEpochMs } from './limit-error-classifier.ts';

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;

type ClassifierProviderService = Pick<
  ReturnType<typeof getProviderService>,
  | 'getAvailableProviders'
  | 'isProviderAvailable'
  | 'getCheapTierModel'
  | 'getTitleGenerationModels'
  | 'getIsolatedEnvForModel'
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
  return fillPrompt(LIMIT_ERROR_CLASSIFIER_PROMPT, {
    now: new Date(now).toISOString(),
    error_text: redactErrorText(rawText).slice(0, 1500),
  });
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
      const mergedEnv = await raceWithDeadline(
        this.deps.providerService.getIsolatedEnvForModel(providerId, models.providerModelId),
        deadline
      );
      if (!mergedEnv) return null;
      const reply = await runOneShotModel({
        prompt: buildPrompt(rawText, now),
        provider: providerId,
        model: models.sdkModelId,
        thinkingModelId: models.providerModelId,
        env: mergedEnv,
        abortController,
        query: this.deps.queryForTesting,
      });
      if (!reply) return null;
      const payload = extractJsonObject(reply);
      if (!payload) return null;
      return parseAssessment(payload);
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
