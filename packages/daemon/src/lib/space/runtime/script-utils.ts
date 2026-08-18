export const MAX_BUFFER_BYTES = 1_048_576;

const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMergeWithDepthLimit(
  target: Record<string, unknown>,
  source: unknown,
  maxDepth = 5
): Record<string, unknown> {
  return _deepMerge(target, source, 0, maxDepth);
}

function _deepMerge(
  target: Record<string, unknown>,
  source: unknown,
  currentDepth: number,
  maxDepth: number
): Record<string, unknown> {
  if (
    currentDepth >= maxDepth ||
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    return target;
  }

  const sourceRecord = source as Record<string, unknown>;

  for (const [key, value] of Object.entries(sourceRecord)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      continue;
    }

    const existing = target[key];

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      target[key] = _deepMerge(
        existing as Record<string, unknown>,
        value,
        currentDepth + 1,
        maxDepth
      );
    } else {
      target[key] = value;
    }
  }

  return target;
}

export function parseJsonStdout(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export async function collectWithMaxBuffer(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) {
    return { text: '', truncated: false };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (truncated) {
        continue;
      }

      if (totalBytes + value.length > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        }
        totalBytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(decoder.decode(value, { stream: true }));
        totalBytes += value.length;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  return { text: chunks.join(''), truncated };
}
