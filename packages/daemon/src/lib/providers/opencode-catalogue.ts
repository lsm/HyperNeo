export type OpencodeWire = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

export interface CatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly context: number;
  readonly released: string;
}

export const MODEL_CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    context: 1_000_000,
    released: '2026-07-31',
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Exp',
    context: 1_000_000,
    released: '2026-08-21',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (New)',
    context: 1_000_000,
    released: '2026-04-24',
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    context: 1_000_000,
    released: '2026-09-10',
  },
  { id: 'glm-5.2', name: 'GLM-5.2', context: 1_000_000, released: '2026-06-13' },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1_000_000, released: '2026-08-14' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context: 1_000_000, released: '2026-08-26' },
  { id: 'hy3', name: 'Hy3', context: 256_000, released: '2026-07-06' },
  { id: 'hy4-preview', name: 'Hy4 preview', context: 1_024_000, released: '2026-08-28' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', context: 262_144, released: '2026-04-21' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', context: 262_144, released: '2026-06-12' },
  { id: 'kimi-k3', name: 'Kimi K3', context: 1_048_576, released: '2026-07-16' },
  { id: 'longcat-2.0', name: 'LongCat-2.0', context: 1_000_000, released: '2026-06-30' },
  {
    id: 'longcat-2.5-preview-free',
    name: 'LongCat 2.5 Preview Free',
    context: 1_000_000,
    released: '2026-09-25',
  },
  { id: 'mimo-v2.5', name: 'MiMo V2.5', context: 1_000_000, released: '2026-04-22' },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context: 1_048_576, released: '2026-04-22' },
  { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', context: 1_048_576, released: '2026-09-22' },
  { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', context: 1_048_576, released: '2026-09-22' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', context: 204_800, released: '2026-03-18' },
  { id: 'minimax-m3', name: 'MiniMax-M3', context: 1_000_000, released: '2026-05-31' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', context: 1_000_000, released: '2026-04-02' },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', context: 1_000_000, released: '2026-05-21' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', context: 1_000_000, released: '2026-06-02' },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', context: 1_000_000, released: '2026-08-26' },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', context: 1_000_000, released: '2026-08-03' },
  { id: 'space-bunny-free', name: 'Space Bunny Free', context: 1_048_576, released: '2026-09-23' },
];

export const FALLBACK_ANTHROPIC_WIRE_IDS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-plus',
]);

export const FALLBACK_RESPONSES_WIRE_IDS = new Set([
  'grok-4.5',
  'grok-4.6',
  'grok-4.7',
  'gpt-5.6-luna',
  'gpt-6-luna',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
]);

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const ANTHROPIC_WIRE_PACKAGE = '@ai-sdk/anthropic';
const RESPONSES_WIRE_PACKAGE = '@ai-sdk/openai';

export function wireForPackage(npm: unknown): OpencodeWire {
  if (npm === ANTHROPIC_WIRE_PACKAGE) return 'anthropic-messages';
  if (npm === RESPONSES_WIRE_PACKAGE) return 'openai-responses';
  return 'openai-chat';
}

export function extractOpencodeGoCatalog(payload: unknown): Map<string, OpencodeModelMetadata> {
  const models = new Map<string, OpencodeModelMetadata>();
  const root = payload as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return models;
  const providers =
    (root.providers as Record<string, unknown> | undefined) ?? (root as Record<string, unknown>);
  const provider = providers['opencode-go'] as { models?: Record<string, unknown> } | undefined;
  const entries = provider?.models;
  if (!entries || typeof entries !== 'object') return models;
  for (const [id, raw] of Object.entries(entries)) {
    const entry = raw as {
      name?: unknown;
      release_date?: unknown;
      limit?: { context?: unknown };
      provider?: { npm?: unknown };
    } | null;
    if (!entry || typeof entry !== 'object') continue;
    const contextWindow = entry.limit?.context;
    models.set(id, {
      id,
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow)
        ? { contextWindow }
        : {}),
      ...(typeof entry.release_date === 'string' ? { releaseDate: entry.release_date } : {}),
      wire: wireForPackage(entry.provider?.npm),
    });
  }
  return models;
}

export interface OpencodeModelMetadata {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly wire: OpencodeWire;
  readonly releaseDate?: string;
}

export function fallbackWireFor(modelId: string): OpencodeWire {
  if (FALLBACK_RESPONSES_WIRE_IDS.has(modelId)) return 'openai-responses';
  if (FALLBACK_ANTHROPIC_WIRE_IDS.has(modelId)) return 'anthropic-messages';
  return 'openai-chat';
}

export function fallbackCatalog(): Map<string, OpencodeModelMetadata> {
  return new Map(
    MODEL_CATALOGUE.map((entry) => [
      entry.id,
      {
        id: entry.id,
        name: entry.name,
        contextWindow: entry.context,
        releaseDate: entry.released,
        wire: fallbackWireFor(entry.id),
      } satisfies OpencodeModelMetadata,
    ])
  );
}
