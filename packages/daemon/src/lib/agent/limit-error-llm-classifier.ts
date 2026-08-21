import { getProviderService, mergeProviderEnvVars } from '../provider-service';
import { Logger } from '../logger';
import { isRunningUnderBun, resolveSDKCliPath } from './sdk-cli-resolver';
import { withSdkTranscriptRetention } from './sdk-transcript-retention';
import { normalizeEpochMs } from './limit-error-classifier';

type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;

type ClassifierProviderService = Pick<
  ReturnType<typeof getProviderService>,
  | 'getAvailableProviders'
  | 'isProviderAvailable'
  | 'getTitleGenerationModels'
  | 'applyEnvVarsToProcessForProvider'
  | 'getEnvVarsForModel'
  | 'restoreEnvVars'
>;

export interface LlmLimitAssessment {
  resetAtMs: number | null;
  kind: 'rate_limit' | 'usage_limit' | null;
  notALimit: boolean;
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

let serializedQueue: Promise<unknown> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = serializedQueue.then(task, task);
  serializedQueue = result.catch(() => undefined);
  return result;
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
  };
}

function buildPrompt(rawText: string, now: number): string {
  return `You classify LLM provider API errors so a scheduler can decide when to retry.

Current time: ${new Date(now).toISOString()}

Error text:
"""
${rawText.slice(0, 1500)}
"""

Rules:
1. is_limit is true only for rate limits, usage caps, quota windows, or throttling — not for auth, payment, server, or network errors.
2. reset_at is the epoch-milliseconds instant when the limit lifts. Use an absolute timestamp in the text (assume timezone UTC+8 for Chinese text unless an explicit zone is given), or compute current time + relative delay for phrases like "retry in 2 hours". Use null when no reset time can be determined.

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

  async classify(rawText: string): Promise<LlmLimitAssessment | null> {
    if (!rawText) return null;
    const key = normalizeErrorText(rawText);
    const now = Date.now();
    const cached = assessmentCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.assessment;
    }
    const assessment = await runSerialized(() => this.classifyUncached(rawText, now));
    assessmentCache.set(key, { assessment, expiresAt: now + CACHE_TTL_MS });
    return assessment;
  }

  private async classifyUncached(rawText: string, now: number): Promise<LlmLimitAssessment | null> {
    try {
      const providerId = await this.resolveClassifierProvider();
      if (!providerId) return null;

      const models = await this.deps.providerService.getTitleGenerationModels(
        providerId,
        'default'
      );
      const providerService = this.deps.providerService;
      const originalEnv = await providerService.applyEnvVarsToProcessForProvider(
        providerId,
        models.providerModelId
      );
      try {
        const providerEnvVars = await providerService.getEnvVarsForModel(
          models.providerModelId,
          providerId
        );
        const query =
          this.deps.queryForTesting ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
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
            env: mergeProviderEnvVars(providerEnvVars as Record<string, string>),
            thinking: { type: 'disabled' },
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
    }
  }

  private async resolveClassifierProvider(): Promise<string | null> {
    const providerService = this.deps.providerService;
    const available = await providerService.getAvailableProviders();
    const candidate = available.find((p) => p.id !== this.deps.excludeProvider) ?? available[0];
    if (!candidate) return null;
    if (!(await providerService.isProviderAvailable(candidate.id))) return null;
    return candidate.id;
  }

  classifyWithTimeout(rawText: string): Promise<LlmLimitAssessment | null> {
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return Promise.race([
      this.classify(rawText),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        if (typeof timer === 'object' && 'unref' in timer) {
          timer.unref();
        }
      }),
    ]);
  }
}
