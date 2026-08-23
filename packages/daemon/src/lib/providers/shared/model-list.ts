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
