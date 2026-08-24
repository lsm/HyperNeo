export function extractAzureDeploymentModel(baseUrl: string): { id: string } | null {
  const parsed = new URL(baseUrl.trim());
  const match = parsed.pathname.match(/\/openai\/deployments\/([^/]+)/i);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]) };
}

export function buildModelListUrl(baseUrl: string, type: string): string {
  const trimmed = baseUrl.trim();
  const parsed = new URL(trimmed);
  let path = parsed.pathname.replace(/\/+$/, '');

  if (type === 'ollama-native') {
    path = path.replace(/\/api\/chat$/i, '');
    path = path.replace(/\/api\/tags$/i, '');
    parsed.pathname = `${path}/api/tags`;
  } else {
    path = path.replace(/\/chat\/completions$/i, '');
    path = path.replace(/\/v1\/messages\/count_tokens$/i, '');
    path = path.replace(/\/v1\/messages$/i, '');
    path = path.replace(/\/v1\/models$/i, '');
    path = path.replace(/\/v1$/i, '');
    parsed.pathname = `${path}/v1/models`;
  }
  return parsed.toString();
}

export function normalizeModelList(
  type: string,
  data: unknown
): Array<{ id: string; name?: string }> {
  if (type === 'ollama-native') {
    const body = data as { models?: Array<{ name?: string; model?: string }> } | undefined;
    const list = body?.models ?? [];
    return list
      .map((m) => {
        const id = m.name || m.model;
        if (!id) return null;
        return { id };
      })
      .filter((m): m is { id: string; name?: string } => m !== null);
  }

  if (type === 'anthropic-messages') {
    const body = data as
      | {
          data?: Array<{
            id?: string;
            type?: string;
            display_name?: string;
            object?: string;
          }>;
        }
      | undefined;
    const list = body?.data ?? [];
    return list
      .map((m) => {
        const id = m.id;
        if (!id) return null;
        const isModel =
          m.type === 'model' ||
          m.object === 'model' ||
          (m.object === undefined && m.type === undefined);
        if (!isModel) return null;
        return m.display_name ? { id, name: m.display_name } : { id };
      })
      .filter((m): m is { id: string; name?: string } => m !== null);
  }

  const body = data as { data?: Array<{ id?: string; object?: string }> } | undefined;
  const list = body?.data ?? [];
  return list
    .map((m) => {
      const id = m.id;
      if (!id) return null;
      if (m.object !== undefined && m.object !== 'model') return null;
      return { id };
    })
    .filter((m): m is { id: string; name?: string } => m !== null);
}

const DEFAULT_REMOTE_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_LIST_CACHE_TTL_MS = 30_000;

export interface RemoteModelListEntry {
  models: Array<{ id: string; name?: string }>;
  fetchedAt: number;
}

export interface RemoteModelListParams {
  url: string;
  type?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  force?: boolean;
  cache?: Map<string, RemoteModelListEntry>;
  cacheTtlMs?: number;
}

function remoteModelListCacheKey(params: {
  url: string;
  type?: string;
  headers?: Record<string, string>;
}): string {
  return JSON.stringify([
    params.url,
    params.type ?? 'openai-chat',
    JSON.stringify(params.headers ?? {}),
  ]);
}

export async function fetchRemoteModelList(
  params: RemoteModelListParams
): Promise<Array<{ id: string; name?: string }>> {
  const type = params.type ?? 'openai-chat';
  const cacheTtlMs = params.cacheTtlMs ?? DEFAULT_REMOTE_LIST_CACHE_TTL_MS;

  if (params.cache && !params.force) {
    const cached = params.cache.get(remoteModelListCacheKey(params));
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
      return cached.models;
    }
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_REMOTE_LIST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(params.url, {
      method: 'GET',
      headers: params.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Endpoint returned HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    const models = normalizeModelList(type, data);
    params.cache?.set(remoteModelListCacheKey(params), { models, fetchedAt: Date.now() });
    return models;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
