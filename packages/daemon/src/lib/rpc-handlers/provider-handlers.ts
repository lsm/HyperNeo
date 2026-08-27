import type {
  CreateProviderParams,
  MessageHub,
  ModelInfo,
  ProviderRecord,
  UpdateProviderParams,
} from '@hyperneo/shared';
import type {
  CuratedModel,
  ListRemoteModelsOptions,
  Provider,
  ProviderCredentials,
} from '@hyperneo/shared/provider';
import type { ProviderRepository } from '../../storage/repositories/provider-repository.ts';
import { parseAcpCommand } from '../acp/acp-command.js';
import { fetchAcpModels } from '../acp/acp-model-fetcher.js';
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  KeychainUnavailableError,
} from '../credentials/credential-store.js';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { AcpProvider } from '../providers/acp-provider.js';
import { markBuiltInProviderDisabled } from '../providers/factory.js';
import {
  parseProviderConfig,
  removeProviderFromRegistry,
  syncProviderToRegistry,
} from '../providers/provider-sync.js';
import { getProviderRegistry } from '../providers/registry.js';
import superpipe, { type PipelineAPI } from 'superpipe';
import { withCustomEndpointsLock } from './custom-endpoint-handlers.js';
import { VOICE_CREDENTIAL_PROVIDER_ID } from './settings-handlers.ts';

const log = new Logger('provider-handlers');

const VALID_PROVIDER_KINDS = new Set(['built_in', 'custom_endpoint']);
const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'none']);
const VALID_REMOTE_MODEL_OPTIONS = new Set(['force', 'command', 'baseUrl']);

const MAX_PROVIDER_ID_LEN = 128;
const MAX_DISPLAY_NAME_LEN = 256;
const MAX_BASE_URL_LEN = 2048;
const MAX_JSON_FIELD_LEN = 64 * 1024;

function validateCreateParams(params: unknown): asserts params is CreateProviderParams {
  if (!params || typeof params !== 'object') throw new Error('Invalid provider params');
  const p = params as Record<string, unknown>;
  if (!p.providerId || typeof p.providerId !== 'string') throw new Error('providerId is required');
  if (p.providerId === VOICE_CREDENTIAL_PROVIDER_ID)
    throw new Error(`providerId '${VOICE_CREDENTIAL_PROVIDER_ID}' is reserved`);
  if (p.providerId.length > MAX_PROVIDER_ID_LEN)
    throw new Error(`providerId must be ≤ ${MAX_PROVIDER_ID_LEN} chars`);
  if (!p.displayName || typeof p.displayName !== 'string')
    throw new Error('displayName is required');
  if (p.displayName.length > MAX_DISPLAY_NAME_LEN)
    throw new Error(`displayName must be ≤ ${MAX_DISPLAY_NAME_LEN} chars`);
  const kind = typeof p.kind === 'string' ? p.kind : '';
  if (!VALID_PROVIDER_KINDS.has(kind))
    throw new Error(`kind must be one of: ${[...VALID_PROVIDER_KINDS].join(', ')}`);
  const authType = typeof p.authType === 'string' ? p.authType : '';
  if (!VALID_AUTH_TYPES.has(authType))
    throw new Error(`authType must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
  if (typeof p.baseUrl === 'string' && p.baseUrl.length > MAX_BASE_URL_LEN)
    throw new Error(`baseUrl must be ≤ ${MAX_BASE_URL_LEN} chars`);
  if (typeof p.configJson === 'string' && p.configJson.length > MAX_JSON_FIELD_LEN)
    throw new Error(`configJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
  if (
    typeof p.customEndpointConfigJson === 'string' &&
    p.customEndpointConfigJson.length > MAX_JSON_FIELD_LEN
  )
    throw new Error(`customEndpointConfigJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
}

function validateUpdateParams(params: unknown): Partial<UpdateProviderParams> {
  if (!params || typeof params !== 'object') throw new Error('Invalid provider update params');
  const p = params as Record<string, unknown>;
  const out: Partial<UpdateProviderParams> = {};
  if (p.displayName !== undefined) {
    if (typeof p.displayName !== 'string') throw new Error('displayName must be a string');
    if (p.displayName.length > MAX_DISPLAY_NAME_LEN)
      throw new Error(`displayName must be ≤ ${MAX_DISPLAY_NAME_LEN} chars`);
    out.displayName = p.displayName;
  }
  if (p.authType !== undefined) {
    const authType = typeof p.authType === 'string' ? p.authType : '';
    if (!VALID_AUTH_TYPES.has(authType)) throw new Error('Invalid authType');
    out.authType = authType as 'api_key' | 'oauth' | 'none';
  }
  if (p.isEnabled !== undefined) out.isEnabled = Boolean(p.isEnabled);
  if (p.isDefault !== undefined) out.isDefault = Boolean(p.isDefault);
  if (p.sortOrder !== undefined) out.sortOrder = Number(p.sortOrder);
  if ('baseUrl' in p) {
    const val = p.baseUrl === undefined ? undefined : String(p.baseUrl);
    if (val !== undefined && val.length > MAX_BASE_URL_LEN)
      throw new Error(`baseUrl must be ≤ ${MAX_BASE_URL_LEN} chars`);
    out.baseUrl = val;
  }
  if ('configJson' in p) {
    const val = p.configJson === undefined ? undefined : String(p.configJson);
    if (val !== undefined && val.length > MAX_JSON_FIELD_LEN)
      throw new Error(`configJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
    out.configJson = val;
  }
  if ('customEndpointConfigJson' in p) {
    const val =
      p.customEndpointConfigJson === undefined ? undefined : String(p.customEndpointConfigJson);
    if (val !== undefined && val.length > MAX_JSON_FIELD_LEN)
      throw new Error(`customEndpointConfigJson must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
    out.customEndpointConfigJson = val;
  }
  return out;
}

type RequestCredentials = {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
};

export async function resolveCredentialsForHydration(
  credentialManager: ProviderCredentialManager,
  providerId: string,
  requestCreds: RequestCredentials | undefined
): Promise<ProviderCredentials | null> {
  if (requestCreds?.apiKey) {
    return { type: 'api_key', apiKey: requestCreds.apiKey };
  }
  if (requestCreds?.oauthAccessToken) {
    const stored = await credentialManager.getCredentials(providerId);
    const raw = stored?.type === 'oauth' ? stored.raw : undefined;
    return {
      type: 'oauth',
      accessToken: requestCreds.oauthAccessToken,
      refreshToken: requestCreds.oauthRefreshToken,
      expiresAt: requestCreds.oauthExpiresAt,
      ...(raw ? { raw } : {}),
    };
  }
  const provider = getProviderRegistry().get(providerId);
  if (provider?.getCredentials) {
    const live = await provider.getCredentials();
    if (live) return live;
  }
  return credentialManager.getCredentials(providerId);
}

let mutationQueue: Promise<unknown> = Promise.resolve();

function withProviderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

function rethrowKeychainError(err: unknown, action: string, providerId: string): never {
  if (err instanceof KeychainUnavailableError) {
    log.warn(`Provider ${action} blocked for ${providerId}: ${KEYCHAIN_UNAVAILABLE_MESSAGE}`);
    throw new Error(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }
  throw err;
}

function validateAcpConfigCommand(configJson: string | undefined): void {
  if (!configJson) return;
  let parsed: { command?: unknown };
  try {
    parsed = JSON.parse(configJson) as { command?: unknown };
  } catch {
    throw new Error('Invalid ACP config JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid ACP config JSON');
  if (parsed.command === undefined) return;
  if (typeof parsed.command !== 'string') throw new Error('ACP command must be a string');
  if (!parsed.command.trim()) throw new Error('ACP command is required');
  parseAcpCommand(parsed.command);
}

function normalizeRemoteModelOptions(value: unknown): ListRemoteModelsOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote model options must be an object');
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !VALID_REMOTE_MODEL_OPTIONS.has(key));
  if (unknown) throw new Error(`Unknown remote model option: ${unknown}`);
  const options: ListRemoteModelsOptions = {};
  if (input.force !== undefined) {
    if (typeof input.force !== 'boolean') throw new Error('force must be a boolean');
    options.force = input.force;
  }
  if (input.command !== undefined) {
    if (typeof input.command !== 'string') throw new Error('ACP command must be a string');
    if (!input.command.trim() && input.command !== '') throw new Error('ACP command is required');
    const command = input.command.trim();
    if (command.length > MAX_JSON_FIELD_LEN) {
      throw new Error(`ACP command must be ≤ ${MAX_JSON_FIELD_LEN} chars`);
    }
    options.command = command;
  }
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string') throw new Error('baseUrl must be a string');
    const baseUrl = input.baseUrl.trim();
    if (baseUrl.length > MAX_BASE_URL_LEN) {
      throw new Error(`baseUrl must be ≤ ${MAX_BASE_URL_LEN} chars`);
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error('Invalid baseUrl');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('baseUrl must use http:// or https://');
    }
    options.baseUrl = baseUrl;
  }
  return options;
}

type RemoteModel = { id: string; name?: string };
type RemoteModelRequest = { id: string; options: unknown };

function validateRemoteModelRequest(data: unknown): RemoteModelRequest {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid remote model request');
  }
  const input = data as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => key !== 'id' && key !== 'options');
  if (unknown) throw new Error(`Unknown remote model request field: ${unknown}`);
  if (typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('Provider id is required');
  }
  return { id: input.id, options: input.options };
}

type RefreshDiscoveryRequest = { id: string };

function validateRefreshDiscoveryRequest(data: unknown): RefreshDiscoveryRequest {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid refresh discovery request');
  }
  const input = data as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => key !== 'id');
  if (unknown) throw new Error(`Unknown refresh discovery request field: ${unknown}`);
  if (typeof input.id !== 'string' || !input.id.trim()) {
    throw new Error('Provider id is required');
  }
  return { id: input.id };
}

async function listAcpRemoteModels(
  record: ProviderRecord,
  options: ListRemoteModelsOptions
): Promise<RemoteModel[]> {
  if (record.providerId !== 'acp') {
    throw new Error(`Provider ${record.id} is not an ACP provider`);
  }
  if (options.baseUrl !== undefined) {
    throw new Error('baseUrl is not supported for ACP providers');
  }
  const useEnvCommand = options.command === '';
  const registered = getProviderRegistry().get('acp');
  const provider =
    registered instanceof AcpProvider && !useEnvCommand ? registered : new AcpProvider();
  if (!(registered instanceof AcpProvider) && !useEnvCommand) {
    provider.setAcpCommand(parseProviderConfig(record.configJson).command);
  }
  return fetchAcpModels(provider, { command: options.command || undefined });
}

const DISCOVERY_REFRESH_TIMEOUT_MS = 30_000;
const DISCOVERY_SETTLE_GRACE_MS = 60_000;

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Provider discovery timed out')), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isUnchangedSavedConfig(
  record: ProviderRecord | null,
  saved: { baseUrl?: string; configJson?: string }
): boolean {
  return (
    !!record &&
    record.isEnabled !== false &&
    record.baseUrl === saved.baseUrl &&
    record.configJson === saved.configJson
  );
}

function isCurationOnlyConfigUpdate(
  previousConfigJson: string | undefined,
  nextConfigJson: string | undefined
): boolean {
  if (previousConfigJson === nextConfigJson) return true;
  if (!previousConfigJson || !nextConfigJson) return false;
  let prev: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    prev = JSON.parse(previousConfigJson) as Record<string, unknown>;
    next = JSON.parse(nextConfigJson) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return false;
  if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'models' || key === LAST_GOOD_DISCOVERY_KEY) continue;
    if (JSON.stringify(prev[key] ?? null) !== JSON.stringify(next[key] ?? null)) return false;
  }
  return true;
}

export interface ProviderHandlerDeps {
  messageHub: MessageHub;
  providerRepo: ProviderRepository;
  credentialManager: ProviderCredentialManager;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
}

const LAST_GOOD_DISCOVERY_KEY = 'discoveredModels';
const LAST_GOOD_DISCOVERY_WRAPPER_RESERVE =
  `${JSON.stringify(LAST_GOOD_DISCOVERY_KEY)}:${JSON.stringify({ models: [], truncated: true })}`
    .length + 1;

interface LastGoodDiscoveredModels {
  models: CuratedModel[];
  truncated?: boolean;
  fingerprint?: string;
}

function lastGoodDiscoveryBudget(
  base: Record<string, unknown>,
  endpointFingerprint?: string
): number {
  const stripped = { ...base };
  delete stripped[LAST_GOOD_DISCOVERY_KEY];
  const prefixLength = Object.keys(stripped).length > 0 ? JSON.stringify(stripped).length + 1 : 1;
  const fingerprintReserve =
    endpointFingerprint === undefined
      ? 0
      : `,"fingerprint":${JSON.stringify(endpointFingerprint)}`.length;
  return Math.max(
    0,
    MAX_JSON_FIELD_LEN - prefixLength - LAST_GOOD_DISCOVERY_WRAPPER_RESERVE - fingerprintReserve
  );
}

function buildLastGoodDiscoveredModels(
  providerId: string,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
  budget: number
): LastGoodDiscoveredModels {
  const registry = getProviderRegistry();
  const byId = new Map<string, CuratedModel>();
  for (const curated of registry.getCuratedModels(providerId) ?? []) {
    if (!byId.has(curated.id)) {
      byId.set(curated.id, {
        id: curated.id,
        ...(curated.name === undefined ? {} : { name: curated.name }),
      });
    }
  }
  const curatedCount = byId.size;
  for (const model of discovered) {
    const seeded = byId.get(model.id);
    if (seeded) {
      if (seeded.name === undefined && model.name !== undefined) seeded.name = model.name;
      continue;
    }
    byId.set(model.id, { id: model.id, ...(model.name === undefined ? {} : { name: model.name }) });
  }
  const models: CuratedModel[] = [];
  let used = 2;
  let index = 0;
  let truncated = false;
  for (const entry of byId.values()) {
    let candidate = entry;
    let cost = JSON.stringify(entry).length + (models.length === 0 ? 0 : 1);
    if (used + cost > budget && index < curatedCount && entry.name !== undefined) {
      const bare: CuratedModel = { id: entry.id };
      const bareCost = JSON.stringify(bare).length + (models.length === 0 ? 0 : 1);
      if (used + bareCost <= budget) {
        candidate = bare;
        cost = bareCost;
      }
    }
    if (used + cost > budget) {
      if (index < curatedCount) {
        throw new Error('Provider config has no capacity to retain all curated models');
      }
      truncated = true;
      break;
    }
    models.push(candidate);
    used += cost;
    index++;
  }
  return { models, ...(truncated ? { truncated: true } : {}) };
}

function persistLastGoodDiscoveredModels(
  providerRepo: ProviderRepository,
  record: ProviderRecord,
  discovered: ReadonlyArray<{ id: string; name?: string }>,
  endpointFingerprint?: string
): boolean {
  let base: Record<string, unknown> = {};
  if (record.configJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.configJson);
    } catch {
      throw new Error(
        'Saved provider config is not valid JSON; refresh rejected to avoid overwriting it'
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'Saved provider config is not a JSON object; refresh rejected to avoid overwriting it'
      );
    }
    base = parsed as Record<string, unknown>;
  }
  const budget = lastGoodDiscoveryBudget(base, endpointFingerprint);
  if (budget < 2) {
    throw new Error('Provider config has no capacity to persist discovery results');
  }
  const lastGood = buildLastGoodDiscoveredModels(record.providerId, discovered, budget);
  base[LAST_GOOD_DISCOVERY_KEY] = {
    ...lastGood,
    ...(endpointFingerprint === undefined ? {} : { fingerprint: endpointFingerprint }),
  };
  providerRepo.updateProvider(record.id, { configJson: JSON.stringify(base) });
  return lastGood.truncated === true;
}

export function stripPersistedDiscovery(configJson: string | undefined): string | undefined {
  if (!configJson) return configJson;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return configJson;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return configJson;
  if (!(LAST_GOOD_DISCOVERY_KEY in parsed)) return configJson;
  delete parsed[LAST_GOOD_DISCOVERY_KEY];
  return JSON.stringify(parsed);
}

function restoreServerDiscoveredModels(
  nextConfigJson: string | undefined,
  previousConfigJson: string | undefined
): string | undefined {
  if (!nextConfigJson) return nextConfigJson;
  let next: Record<string, unknown>;
  try {
    next = JSON.parse(nextConfigJson) as Record<string, unknown>;
  } catch {
    return nextConfigJson;
  }
  if (!next || typeof next !== 'object' || Array.isArray(next)) return nextConfigJson;
  let prev: Record<string, unknown> = {};
  if (previousConfigJson) {
    try {
      const parsed = JSON.parse(previousConfigJson) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prev = parsed;
      }
    } catch {}
  }
  const serverDiscovered = prev[LAST_GOOD_DISCOVERY_KEY];
  if (serverDiscovered === undefined) {
    if (!(LAST_GOOD_DISCOVERY_KEY in next)) return nextConfigJson;
    delete next[LAST_GOOD_DISCOVERY_KEY];
    return JSON.stringify(next);
  }
  if (JSON.stringify(next[LAST_GOOD_DISCOVERY_KEY] ?? null) === JSON.stringify(serverDiscovered)) {
    return nextConfigJson;
  }
  next[LAST_GOOD_DISCOVERY_KEY] = serverDiscovered;
  return JSON.stringify(next);
}

type SavedConfigDiscoveryRefreshOutcome =
  | { success: false; reason: 'superseded' }
  | {
      success: true;
      truncated?: boolean;
      models: Array<{ id: string; name?: string }>;
    };

interface CommitSavedConfigDiscoveryRefreshDeps {
  providerRepo: ProviderRepository;
  provider: Provider;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  getModelsCacheClearSequence(): number;
  getCurrentCacheLoad(cacheKey?: string): Promise<void> | undefined;
  applyDiscoveredProviderModels(
    providerId: string,
    models: ModelInfo[],
    cacheKey?: string,
    persistedDiscovered?: ReadonlyArray<{ id: string; name?: string }>
  ): boolean;
  releaseAppliedProviderSlice(providerId: string, cacheKey?: string): void;
  schedulePendingSliceRelease(providerId: string, cacheKey?: string): void;
  markProviderRefreshSucceeded(providerId: string): boolean;
  mergeDiscoveredWithStatic(providerId: string, discovered: ReadonlyArray<ModelInfo>): ModelInfo[];
}

interface CommitSavedConfigDiscoveryRefreshCtx {
  deps: CommitSavedConfigDiscoveryRefreshDeps;
  providerId: string;
  rowId: string;
  savedConfig: { baseUrl?: string; configJson?: string };
  discoveryBaseUrl: string | undefined;
  originalConfigJson: string | undefined;
  credentialsAtStart: string;
  clearsAtStart: number;
  discovered: ModelInfo[];
  persistedDiscovered: ReadonlyArray<{ id: string; name?: string }>;
  currentRecord?: ProviderRecord | null;
  persistedConfig?: { baseUrl?: string; configJson?: string };
  normalizedDiscovered?: ModelInfo[];
  truncated?: boolean;
  recoveredFailure?: boolean;
  outcome?: SavedConfigDiscoveryRefreshOutcome;
}

async function revalidateSavedConfigUnderLock(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): Promise<CommitSavedConfigDiscoveryRefreshCtx> {
  const currentRecord = ctx.deps.providerRepo.getProvider(ctx.rowId);
  if (
    ctx.deps.getModelsCacheClearSequence() !== ctx.clearsAtStart ||
    JSON.stringify((await ctx.deps.provider.getCredentials?.()) ?? null) !==
      ctx.credentialsAtStart ||
    !isUnchangedSavedConfig(currentRecord, ctx.savedConfig)
  ) {
    ctx.deps.provider.clearModelCache?.();
    return { ...ctx, currentRecord, outcome: { success: false, reason: 'superseded' } };
  }
  return { ...ctx, currentRecord };
}

function persistLastGoodSlice(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  let truncated = false;
  try {
    truncated = persistLastGoodDiscoveredModels(
      ctx.deps.providerRepo,
      ctx.currentRecord!,
      ctx.discovered,
      ctx.deps.provider.getDiscoveryEndpointFingerprint?.(ctx.discoveryBaseUrl)
    );
  } catch (persistError) {
    ctx.deps.provider.clearModelCache?.();
    throw persistError;
  }
  return {
    ...ctx,
    truncated,
    persistedConfig: {
      baseUrl: ctx.savedConfig.baseUrl,
      configJson: ctx.deps.providerRepo.getProvider(ctx.rowId)?.configJson,
    },
  };
}

async function applyDiscoveredSliceToLiveCache(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): Promise<CommitSavedConfigDiscoveryRefreshCtx> {
  const normalizedDiscovered = ctx.deps.mergeDiscoveredWithStatic(ctx.providerId, ctx.discovered);
  const applied = ctx.deps.applyDiscoveredProviderModels(
    ctx.providerId,
    normalizedDiscovered,
    'global',
    ctx.persistedDiscovered
  );
  if (applied) {
    ctx.deps.releaseAppliedProviderSlice(ctx.providerId);
    return { ...ctx, normalizedDiscovered };
  }
  const inFlight = ctx.deps.getCurrentCacheLoad();
  if (!inFlight) {
    ctx.deps.schedulePendingSliceRelease(ctx.providerId);
    return { ...ctx, normalizedDiscovered };
  }
  await raceWithTimeout(
    inFlight.catch(() => {}),
    DISCOVERY_REFRESH_TIMEOUT_MS
  ).catch(() => {});
  const supersededDuringWait =
    ctx.deps.getModelsCacheClearSequence() !== ctx.clearsAtStart ||
    JSON.stringify((await ctx.deps.provider.getCredentials?.()) ?? null) !==
      ctx.credentialsAtStart ||
    !isUnchangedSavedConfig(ctx.deps.providerRepo.getProvider(ctx.rowId), ctx.persistedConfig!);
  const currentRow = ctx.deps.providerRepo.getProvider(ctx.rowId);
  if (supersededDuringWait) {
    ctx.deps.releaseAppliedProviderSlice(ctx.providerId);
    if (currentRow && currentRow.configJson === ctx.persistedConfig!.configJson) {
      ctx.deps.providerRepo.updateProvider(ctx.rowId, { configJson: ctx.originalConfigJson });
    }
    ctx.deps.provider.clearModelCache?.();
    return { ...ctx, normalizedDiscovered, outcome: { success: false, reason: 'superseded' } };
  }
  if (
    ctx.deps.applyDiscoveredProviderModels(
      ctx.providerId,
      normalizedDiscovered,
      'global',
      ctx.persistedDiscovered
    )
  ) {
    ctx.deps.releaseAppliedProviderSlice(ctx.providerId);
  } else {
    ctx.deps.schedulePendingSliceRelease(ctx.providerId);
  }
  return { ...ctx, normalizedDiscovered };
}

function markRefreshSucceededAndHealthy(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  const recoveredFailure = ctx.deps.markProviderRefreshSucceeded(ctx.providerId);
  ctx.deps.providerRepo.updateProvider(ctx.rowId, {
    healthStatus: 'healthy',
    lastHealthCheckAt: Date.now(),
  });
  return { ...ctx, recoveredFailure };
}

function publishProvidersChangedWhenCoherent(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  if (!ctx.recoveredFailure) notifyProvidersChanged(ctx.deps.internalEventBus);
  return ctx;
}

function assembleRefreshResult(
  ctx: CommitSavedConfigDiscoveryRefreshCtx
): CommitSavedConfigDiscoveryRefreshCtx {
  return {
    ...ctx,
    outcome: {
      success: true,
      ...(ctx.truncated ? { truncated: true } : {}),
      models: ctx.discovered.map(({ id, name }) => ({
        id,
        ...(name === undefined ? {} : { name }),
      })),
    },
  };
}

const runCommitSavedConfigDiscoveryRefresh = (
  superpipe<{
    hasOutcome: (ctx: CommitSavedConfigDiscoveryRefreshCtx) => boolean;
  }>({
    hasOutcome: (ctx: CommitSavedConfigDiscoveryRefreshCtx): boolean => ctx.outcome !== undefined,
  })('commit-saved-config-discovery-refresh') as PipelineAPI
)
  .input(['ctx'])
  .pipe(revalidateSavedConfigUnderLock, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(persistLastGoodSlice, 'ctx', 'ctx')
  .pipe(applyDiscoveredSliceToLiveCache, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(markRefreshSucceededAndHealthy, 'ctx', 'ctx')
  .pipe(publishProvidersChangedWhenCoherent, 'ctx', 'ctx')
  .pipe(assembleRefreshResult, 'ctx', 'ctx')
  .endAsync('ctx') as unknown as (
  ctx: CommitSavedConfigDiscoveryRefreshCtx
) => Promise<CommitSavedConfigDiscoveryRefreshCtx>;

function notifyProvidersChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
}

async function clearCacheAndNotifyProvidersChanged(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>
): Promise<void> {
  const { clearModelsCache } = await import('../model-service.js');
  clearModelsCache();
  notifyProvidersChanged(internalEventBus);
}

export function setupProviderHandlers(deps: ProviderHandlerDeps): void {
  const { messageHub, providerRepo, credentialManager, internalEventBus } = deps;

  messageHub.onRequest('providers.list', async () => {
    const records = providerRepo.listProviders();
    const registry = getProviderRegistry();
    const enriched = await Promise.all(
      records.map(async (record) => {
        const provider = registry.get(record.providerId);
        if (!provider) return { ...record, available: false };
        try {
          return { ...record, available: await provider.isAvailable() };
        } catch (error) {
          log.error(`Failed to check availability for ${record.providerId}:`, error);
          return { ...record, available: false };
        }
      })
    );
    return { providers: enriched };
  });

  messageHub.onRequest('providers.get', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    const provider = getProviderRegistry().get(record.providerId);
    const available = provider ? await provider.isAvailable() : false;
    return { provider: { ...record, available } };
  });

  messageHub.onRequest('providers.listRemoteModels', async (data: unknown) => {
    const request = validateRemoteModelRequest(data);
    const record = providerRepo.getProvider(request.id);
    if (!record) throw new Error(`Provider ${request.id} not found`);
    const options = normalizeRemoteModelOptions(request.options);
    let models: RemoteModel[];
    if (record.providerId === 'acp') {
      models = await listAcpRemoteModels(record, options);
    } else {
      if (options.command !== undefined) {
        throw new Error('command is only supported for ACP providers');
      }
      const provider = getProviderRegistry().get(record.providerId);
      if (!provider) throw new Error(`Provider ${record.providerId} is not registered`);
      if (!provider.listRemoteModels) {
        throw new Error(`Provider ${record.providerId} does not support remote model listing`);
      }
      models = await provider.listRemoteModels(options);
    }
    return {
      models: models.map(({ id, name }) => ({ id, ...(name === undefined ? {} : { name }) })),
    };
  });

  messageHub.onRequest('providers.refreshDiscovery', async (data: unknown) => {
    const request = validateRefreshDiscoveryRequest(data);
    const record = providerRepo.getProvider(request.id);
    if (!record) throw new Error(`Provider ${request.id} not found`);
    const provider = getProviderRegistry().get(record.providerId);
    if (!provider) throw new Error(`Provider ${record.providerId} is not registered`);
    if (!provider.listRemoteModels) {
      throw new Error(`Provider ${record.providerId} does not support remote model listing`);
    }

    const {
      getModelsCacheClearSequence,
      getCurrentCacheLoad,
      applyDiscoveredProviderModels,
      releaseAppliedProviderSlice,
      schedulePendingSliceRelease,
      markProviderRefreshSucceeded,
      mergeDiscoveredWithStatic,
    } = await import('../model-service.js');
    const clearsAtStart = getModelsCacheClearSequence();
    const savedConfig = { baseUrl: record.baseUrl, configJson: record.configJson };
    const discoveryBaseUrl = record.baseUrl || undefined;
    const credentialsAtStart = JSON.stringify((await provider.getCredentials?.()) ?? null);

    const discoveryPromise = provider.listRemoteModels({
      force: true,
      ...(discoveryBaseUrl ? { baseUrl: discoveryBaseUrl } : {}),
    });
    let discovered: ModelInfo[];
    try {
      discovered = await raceWithTimeout(discoveryPromise, DISCOVERY_REFRESH_TIMEOUT_MS);
    } catch (error) {
      await raceWithTimeout(
        discoveryPromise.catch(() => {}),
        DISCOVERY_SETTLE_GRACE_MS
      ).catch(() => {});
      provider.clearModelCache?.();
      discoveryPromise.then(() => provider.clearModelCache?.()).catch(() => {});
      throw error;
    }
    if (discovered.length === 0) {
      provider.clearModelCache?.();
      throw new Error(`Provider ${record.providerId} returned no models`);
    }

    if (
      getModelsCacheClearSequence() !== clearsAtStart ||
      JSON.stringify((await provider.getCredentials?.()) ?? null) !== credentialsAtStart ||
      !isUnchangedSavedConfig(providerRepo.getProvider(request.id), savedConfig)
    ) {
      provider.clearModelCache?.();
      return { success: false, reason: 'superseded' };
    }
    const persistedConfig = parseProviderConfig(savedConfig.configJson);
    const persistedDiscovered = persistedConfig.models ?? [];

    const committed = await withProviderLock(() =>
      runCommitSavedConfigDiscoveryRefresh({
        deps: {
          providerRepo,
          provider,
          internalEventBus,
          getModelsCacheClearSequence,
          getCurrentCacheLoad,
          applyDiscoveredProviderModels,
          releaseAppliedProviderSlice,
          schedulePendingSliceRelease,
          markProviderRefreshSucceeded,
          mergeDiscoveredWithStatic,
        },
        providerId: record.providerId,
        rowId: request.id,
        savedConfig,
        discoveryBaseUrl,
        originalConfigJson: record.configJson,
        credentialsAtStart,
        clearsAtStart,
        discovered,
        persistedDiscovered,
      })
    );
    const outcome = committed?.outcome;
    if (!outcome) {
      throw new Error('providers.refreshDiscovery: commit settled without an outcome');
    }
    return outcome;
  });

  messageHub.onRequest(
    'providers.fetchAcpModels',
    async (data: { id: string; command?: string }) => {
      const record = providerRepo.getProvider(data.id);
      if (!record) throw new Error(`Provider ${data.id} not found`);
      if (record.providerId !== 'acp') {
        throw new Error(`Provider ${data.id} is not an ACP provider`);
      }
      const options = normalizeRemoteModelOptions({ command: data.command });
      return { models: await listAcpRemoteModels(record, options) };
    }
  );

  messageHub.onRequest(
    'providers.create',
    async (data: {
      params: CreateProviderParams;
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        oauthAccessToken?: string;
        oauthRefreshToken?: string;
        oauthExpiresAt?: number;
      };
    }) => {
      const lock =
        data.params.kind === 'custom_endpoint' ? withCustomEndpointsLock : withProviderLock;
      return lock(async () => {
        validateCreateParams(data.params);
        if (data.params.providerId === 'acp') {
          validateAcpConfigCommand(data.params.configJson);
        }
        const params = { ...data.params };
        const strippedConfig = stripPersistedDiscovery(params.configJson);
        if (strippedConfig !== params.configJson) {
          params.configJson = strippedConfig;
        }
        const record = providerRepo.createProvider(params);

        try {
          if (record.kind !== 'custom_endpoint') {
            if (data.credentials?.apiKey) {
              await credentialManager.storeApiKey(record.providerId, data.credentials.apiKey);
            } else if (data.credentials?.oauthAccessToken) {
              await credentialManager.storeOAuthTokens(record.providerId, {
                accessToken: data.credentials.oauthAccessToken,
                refreshToken: data.credentials.oauthRefreshToken,
                expiresAt: data.credentials.oauthExpiresAt,
              });
            }
          }

          if (record.isEnabled) {
            if (record.kind === 'built_in') {
              const { ensureBuiltInProviderRegistered } = await import('../providers/factory.js');
              await ensureBuiltInProviderRegistered(record.providerId);
            }
            const creds = await resolveCredentialsForHydration(
              credentialManager,
              record.providerId,
              data.credentials
            );
            await syncProviderToRegistry(record, creds);
          } else if (record.kind === 'built_in') {
            markBuiltInProviderDisabled(record.providerId);
            await removeProviderFromRegistry(record.providerId, { preserveCredentials: true });
          }
        } catch (err) {
          providerRepo.deleteProvider(record.id);
          rethrowKeychainError(err, 'create', record.providerId);
        }

        await clearCacheAndNotifyProvidersChanged(internalEventBus);

        return { success: true, provider: record };
      });
    }
  );

  messageHub.onRequest(
    'providers.update',
    async (data: {
      id: string;
      params: Partial<UpdateProviderParams>;
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        oauthAccessToken?: string;
        oauthRefreshToken?: string;
        oauthExpiresAt?: number;
      };
    }) => {
      return withProviderLock(async () => {
        const updates = validateUpdateParams(data.params);
        const existing = providerRepo.getProvider(data.id);
        if (!existing) throw new Error(`Provider ${data.id} not found`);
        if (existing.providerId === VOICE_CREDENTIAL_PROVIDER_ID)
          throw new Error(`providerId '${VOICE_CREDENTIAL_PROVIDER_ID}' is reserved`);
        if (existing.providerId === 'acp' && updates.configJson !== undefined) {
          validateAcpConfigCommand(updates.configJson);
        }
        const lock =
          existing.kind === 'custom_endpoint'
            ? withCustomEndpointsLock
            : (fn: () => Promise<unknown>) => fn();
        return lock(async () => {
          if (
            updates.configJson !== undefined &&
            existing.configJson !== updates.configJson &&
            isCurationOnlyConfigUpdate(existing.configJson, updates.configJson) &&
            data.credentials === undefined &&
            updates.baseUrl === undefined &&
            updates.customEndpointConfigJson === undefined
          ) {
            const restoredConfig = restoreServerDiscoveredModels(
              updates.configJson,
              existing.configJson
            );
            if (restoredConfig && restoredConfig.length > MAX_JSON_FIELD_LEN) {
              throw new Error(
                `configJson must be ≤ ${MAX_JSON_FIELD_LEN} chars after restoring persisted discovery`
              );
            }
            if (restoredConfig !== undefined) {
              updates.configJson = restoredConfig;
            }
          }

          const discoveryInvalidating =
            data.credentials !== undefined ||
            updates.baseUrl !== undefined ||
            updates.customEndpointConfigJson !== undefined ||
            updates.isEnabled === false ||
            (updates.configJson !== undefined &&
              !isCurationOnlyConfigUpdate(existing.configJson, updates.configJson));
          let strippedRowOriginalConfig: { value: string | undefined } | undefined;
          if (discoveryInvalidating) {
            const configSource = updates.configJson ?? existing.configJson;
            const strippedConfig = stripPersistedDiscovery(configSource);
            if (strippedConfig !== configSource) {
              providerRepo.updateProvider(data.id, { configJson: strippedConfig });
              updates.configJson = strippedConfig;
              strippedRowOriginalConfig = { value: existing.configJson };
            }
          }

          if (data.credentials && existing.kind !== 'custom_endpoint') {
            try {
              if (data.credentials.apiKey) {
                await credentialManager.storeApiKey(existing.providerId, data.credentials.apiKey);
                updates.authType = 'api_key';
              } else if (data.credentials.oauthAccessToken) {
                await credentialManager.storeOAuthTokens(existing.providerId, {
                  accessToken: data.credentials.oauthAccessToken,
                  refreshToken: data.credentials.oauthRefreshToken,
                  expiresAt: data.credentials.oauthExpiresAt,
                });
                updates.authType = 'oauth';
              }
            } catch (err) {
              if (strippedRowOriginalConfig) {
                providerRepo.updateProvider(data.id, {
                  configJson: strippedRowOriginalConfig.value,
                });
              }
              rethrowKeychainError(err, 'update', existing.providerId);
            }
          }

          let record = providerRepo.updateProvider(data.id, updates);
          if (!record) throw new Error(`Provider ${data.id} not found`);

          const shouldResync =
            data.credentials !== undefined ||
            updates.baseUrl !== undefined ||
            updates.customEndpointConfigJson !== undefined ||
            updates.configJson !== undefined ||
            updates.isEnabled !== undefined;

          const curationOnlyConfigUpdate = isCurationOnlyConfigUpdate(
            existing.configJson,
            record.configJson
          );

          if (shouldResync) {
            if (
              curationOnlyConfigUpdate &&
              updates.configJson !== undefined &&
              data.credentials === undefined &&
              updates.baseUrl === undefined &&
              updates.customEndpointConfigJson === undefined &&
              !discoveryInvalidating
            ) {
              const restoredConfig = restoreServerDiscoveredModels(
                record.configJson,
                existing.configJson
              );
              if (restoredConfig !== record.configJson) {
                record =
                  providerRepo.updateProvider(data.id, { configJson: restoredConfig }) ?? record;
              }
            }
            if (record.isEnabled === false) {
              if (record.kind === 'built_in') {
                markBuiltInProviderDisabled(record.providerId);
              }
              await removeProviderFromRegistry(record.providerId, { preserveCredentials: true });
            } else {
              const { ensureBuiltInProviderRegistered } = await import('../providers/factory.js');
              await ensureBuiltInProviderRegistered(record.providerId);
              const creds = await resolveCredentialsForHydration(
                credentialManager,
                record.providerId,
                data.credentials
              );
              await syncProviderToRegistry(record, creds);
            }
          }

          await clearCacheAndNotifyProvidersChanged(internalEventBus);

          return { success: true, provider: record };
        });
      });
    }
  );

  messageHub.onRequest('providers.delete', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);
    if (record.providerId === VOICE_CREDENTIAL_PROVIDER_ID)
      throw new Error(`providerId '${VOICE_CREDENTIAL_PROVIDER_ID}' is reserved`);
    const lock = record.kind === 'custom_endpoint' ? withCustomEndpointsLock : withProviderLock;
    return lock(async () => {
      if (record.kind !== 'custom_endpoint') {
        try {
          await credentialManager.removeCredentials(record.providerId);
        } catch (error) {
          rethrowKeychainError(error, 'delete', record.providerId);
        }
      }

      if (record.kind === 'built_in') {
        const currentRow = providerRepo.getProvider(data.id) ?? record;
        const strippedConfig = stripPersistedDiscovery(currentRow.configJson);
        const updates: UpdateProviderParams = { isEnabled: false };
        if (strippedConfig !== currentRow.configJson) {
          updates.configJson = strippedConfig;
        }
        providerRepo.updateProvider(data.id, updates);
        markBuiltInProviderDisabled(record.providerId);
      } else {
        providerRepo.deleteProvider(data.id);
      }
      await removeProviderFromRegistry(record.providerId);
      await clearCacheAndNotifyProvidersChanged(internalEventBus);
      return { success: true };
    });
  });

  messageHub.onRequest('providers.setDefault', async (data: { id: string }) => {
    return withProviderLock(async () => {
      providerRepo.setDefaultProvider(data.id);
      notifyProvidersChanged(internalEventBus);
      return { success: true };
    });
  });

  messageHub.onRequest('providers.test', async (data: { id: string }) => {
    const record = providerRepo.getProvider(data.id);
    if (!record) throw new Error(`Provider ${data.id} not found`);

    const provider = getProviderRegistry().get(record.providerId);
    if (!provider) {
      providerRepo.updateProvider(data.id, {
        healthStatus: 'unhealthy',
        lastHealthCheckAt: Date.now(),
      });
      notifyProvidersChanged(internalEventBus);
      return { healthy: false, error: 'Provider not registered' };
    }

    try {
      const available = await provider.isAvailable();
      if (!available) {
        providerRepo.updateProvider(data.id, {
          healthStatus: 'unhealthy',
          lastHealthCheckAt: Date.now(),
        });
        notifyProvidersChanged(internalEventBus);
        return { healthy: false, error: 'Provider not available' };
      }
      if (provider instanceof AcpProvider) {
        await provider.verifyCommandAvailable({ force: true });
      }
      await provider.getModels();
      providerRepo.updateProvider(data.id, {
        healthStatus: 'healthy',
        lastHealthCheckAt: Date.now(),
      });
      notifyProvidersChanged(internalEventBus);
      return { healthy: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      providerRepo.updateProvider(data.id, {
        healthStatus: 'unhealthy',
        lastHealthCheckAt: Date.now(),
      });
      notifyProvidersChanged(internalEventBus);
      return { healthy: false, error };
    }
  });

  messageHub.onRequest('providers.healthCheck', async () => {
    const records = providerRepo.listEnabledProviders();
    const registry = getProviderRegistry();
    const results = await Promise.all(
      records.map(async (record) => {
        const provider = registry.get(record.providerId);
        if (!provider) {
          providerRepo.updateProvider(record.id, {
            healthStatus: 'unhealthy',
            lastHealthCheckAt: Date.now(),
          });
          return { providerId: record.providerId, healthy: false, error: 'Not registered' };
        }
        try {
          const available = await provider.isAvailable();
          if (!available) {
            providerRepo.updateProvider(record.id, {
              healthStatus: 'unhealthy',
              lastHealthCheckAt: Date.now(),
            });
            return { providerId: record.providerId, healthy: false, error: 'Not available' };
          }
          if (provider instanceof AcpProvider) {
            await provider.verifyCommandAvailable();
          }
          await provider.getModels();
          providerRepo.updateProvider(record.id, {
            healthStatus: 'healthy',
            lastHealthCheckAt: Date.now(),
          });
          return { providerId: record.providerId, healthy: true };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          providerRepo.updateProvider(record.id, {
            healthStatus: 'unhealthy',
            lastHealthCheckAt: Date.now(),
          });
          return { providerId: record.providerId, healthy: false, error };
        }
      })
    );
    notifyProvidersChanged(internalEventBus);
    return { results };
  });
}
