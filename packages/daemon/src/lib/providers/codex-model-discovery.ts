import * as fs from 'fs/promises';
import * as path from 'path';
import type { ModelInfo } from '@hyperneo/shared';
import { getCodexBridgeModelInfos } from './codex-models.js';

export const CODEX_MODELS_CLIENT_VERSION = '1.0.0';

export const CODEX_MODELS_ENDPOINT = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`;

export const CODEX_MODELS_CACHE_FILE_NAME = 'codex-models-cache.json';

export const CODEX_DISCOVERY_TTL_MS = 5 * 60_000;

export const CODEX_DISCOVERY_TIMEOUT_MS = 5_000;

export const CODEX_DISCOVERY_MAX_MODELS = 200;

export type CodexModelVisibility = 'list' | 'hide' | 'none';

export interface CodexRemoteModel {
  slug: string;
  display_name: string;
  description?: string;
  visibility: CodexModelVisibility;
  supported_in_api: boolean;
  priority: number;
  context_window?: number;
  max_context_window?: number;
}

export interface CodexModelsResponse {
  models: CodexRemoteModel[];
}

export interface CodexModelPolicy {
  allowPatterns: readonly RegExp[];
  denyPatterns: readonly RegExp[];
  pinnedOrder: readonly string[];
  pinnedDefault?: string;
}

export const CODEX_MODEL_POLICY: CodexModelPolicy = {
  allowPatterns: [/^gpt-/],
  denyPatterns: [],
  pinnedOrder: [],
};

const STATIC_CODEX_MODELS = getCodexBridgeModelInfos();

function staticModelForSlug(slug: string): ModelInfo | undefined {
  return STATIC_CODEX_MODELS.find(
    (model) => model.id === slug || model.alias === slug || model.providerAliases?.includes(slug)
  );
}

export function slugMatchesAny(slug: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(slug));
}

function parseCodexRemoteEntry(entry: unknown): CodexRemoteModel | null {
  if (!entry || typeof entry !== 'object') return null;
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.slug !== 'string' || candidate.slug.length === 0) return null;
  if (typeof candidate.display_name !== 'string') return null;
  return {
    slug: candidate.slug,
    display_name: candidate.display_name,
    ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
    visibility:
      candidate.visibility === 'hide' || candidate.visibility === 'none'
        ? candidate.visibility
        : 'list',
    supported_in_api: candidate.supported_in_api !== false,
    priority: typeof candidate.priority === 'number' ? candidate.priority : 0,
    ...(typeof candidate.context_window === 'number'
      ? { context_window: candidate.context_window }
      : {}),
    ...(typeof candidate.max_context_window === 'number'
      ? { max_context_window: candidate.max_context_window }
      : {}),
  };
}

function parseCodexRemoteModels(entries: readonly unknown[]): CodexRemoteModel[] {
  const models: CodexRemoteModel[] = [];
  for (const entry of entries) {
    const parsed = parseCodexRemoteEntry(entry);
    if (parsed) models.push(parsed);
    if (models.length >= CODEX_DISCOVERY_MAX_MODELS) break;
  }
  return models;
}

export function applyCodexDiscoveryPolicy(
  models: readonly CodexRemoteModel[],
  policy: CodexModelPolicy = CODEX_MODEL_POLICY
): CodexRemoteModel[] {
  const allowed = models.filter(
    (model) =>
      model.visibility === 'list' &&
      model.supported_in_api &&
      slugMatchesAny(model.slug, policy.allowPatterns) &&
      !slugMatchesAny(model.slug, policy.denyPatterns)
  );
  const pinnedRank = new Map(policy.pinnedOrder.map((slug, index) => [slug, index]));
  return [...allowed].sort((a, b) => {
    const aPinned = pinnedRank.get(a.slug);
    const bPinned = pinnedRank.get(b.slug);
    if (aPinned !== undefined && bPinned !== undefined) return aPinned - bPinned;
    if (aPinned !== undefined) return -1;
    if (bPinned !== undefined) return 1;
    return a.priority - b.priority;
  });
}

export function normalizeCodexRemoteModel(model: CodexRemoteModel): ModelInfo {
  const staticModel = staticModelForSlug(model.slug);
  const contextWindow =
    model.context_window ?? model.max_context_window ?? staticModel?.contextWindow ?? 128000;
  const description =
    model.description ?? staticModel?.description ?? (model.display_name || model.slug);
  return {
    id: model.slug,
    name: model.display_name || staticModel?.name || model.slug,
    alias: staticModel?.alias ?? '',
    ...(staticModel?.providerAliases ? { providerAliases: staticModel.providerAliases } : {}),
    sdkModelIds: [model.slug],
    family: 'gpt',
    provider: 'anthropic-codex',
    contextWindow,
    preferContextWindowMetadata: true,
    description,
    releaseDate: staticModel?.releaseDate ?? '',
    available: true,
  };
}

export function normalizeCodexRemoteModels(
  models: readonly CodexRemoteModel[],
  policy: CodexModelPolicy = CODEX_MODEL_POLICY
): ModelInfo[] {
  return applyCodexDiscoveryPolicy(models, policy).map(normalizeCodexRemoteModel);
}

export function mergeCodexDiscoveredWithStatic(discovered: readonly ModelInfo[]): ModelInfo[] {
  if (discovered.length === 0) return STATIC_CODEX_MODELS.map((model) => ({ ...model }));
  const discoveredIds = new Set(discovered.map((model) => model.id));
  const retained = STATIC_CODEX_MODELS.filter((model) => !discoveredIds.has(model.id)).map(
    (model) => ({ ...model, available: false })
  );
  return [...discovered.map((model) => ({ ...model })), ...retained];
}

export interface CodexModelsCacheFile {
  version: 1;
  accountId?: string;
  fetchedAt: number;
  models: CodexRemoteModel[];
}

export function parseCodexModelsCacheFile(
  raw: string,
  accountId: string | undefined,
  now: number = Date.now()
): CodexModelsCacheFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!Array.isArray(record.models)) return null;
  if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return null;
  if (record.fetchedAt > now) return null;
  if (typeof record.accountId === 'string' && accountId && record.accountId !== accountId) {
    return null;
  }
  return {
    version: 1,
    fetchedAt: record.fetchedAt,
    ...(accountId ? { accountId } : {}),
    models: parseCodexRemoteModels(record.models),
  };
}

export class CodexModelsCache {
  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number = CODEX_DISCOVERY_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  async loadFresh(accountId: string | undefined): Promise<CodexRemoteModel[] | null> {
    const entry = await this.load(accountId);
    if (!entry) return null;
    if (this.now() - entry.fetchedAt >= this.ttlMs) return null;
    return entry.models;
  }

  async loadLastGood(accountId: string | undefined): Promise<CodexRemoteModel[] | null> {
    return (await this.load(accountId))?.models ?? null;
  }

  async load(accountId: string | undefined): Promise<CodexModelsCacheFile | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      return null;
    }
    return parseCodexModelsCacheFile(raw, accountId, this.now());
  }

  async save(models: readonly CodexRemoteModel[], accountId: string | undefined): Promise<void> {
    const file: CodexModelsCacheFile = {
      version: 1,
      ...(accountId ? { accountId } : {}),
      fetchedAt: this.now(),
      models: models.slice(0, CODEX_DISCOVERY_MAX_MODELS),
    };
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(file), { mode: 0o600 });
      await fs.rename(tmpPath, this.filePath);
    } catch {}
  }
}

export async function fetchCodexRemoteModels(
  auth: { apiKey: string; accountId?: string },
  fetchImpl: typeof fetch,
  timeoutMs: number = CODEX_DISCOVERY_TIMEOUT_MS
): Promise<CodexRemoteModel[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.apiKey}`,
    accept: 'application/json',
  };
  if (auth.accountId) {
    headers['ChatGPT-Account-ID'] = auth.accountId;
  }
  const response = await fetchImpl(CODEX_MODELS_ENDPOINT, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Codex models discovery failed (HTTP ${response.status})`);
  }
  const parsed = (await response.json()) as Partial<CodexModelsResponse>;
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error('Codex models discovery returned an unexpected payload');
  }
  return parseCodexRemoteModels(parsed.models);
}
