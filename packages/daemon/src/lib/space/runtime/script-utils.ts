/**
 * Shared script utilities used by hook script execution and GitHub-lookup
 * helpers: prototype-pollution-safe deep merge, JSON stdout parsing, and
 * max-buffer stream collection. These were originally co-located with the
 * retired gate script executor; they are generic and belong to the hook/runtime
 * layer.
 */

/** Maximum stdout/stderr buffer size (1 MB). */
export const MAX_BUFFER_BYTES = 1_048_576;

/** Keys that are rejected during deep-merge to prevent prototype pollution. */
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-merges `source` into `target` with a configurable depth limit.
 *
 * Rejects `__proto__`, `constructor`, and `prototype` keys at every level
 * to prevent prototype pollution attacks from malicious script output.
 *
 * @param target  The target object to merge into.
 * @param source  The source object to merge from.
 * @param maxDepth  Maximum recursion depth (default 5).
 * @returns The merged target object.
 */
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
    // Block prototype pollution keys
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

/**
 * Parses raw stdout from a script as JSON.
 *
 * Returns the parsed object on success, or `null` if the output is empty,
 * whitespace-only, or not valid JSON. Errors are silently swallowed so that
 * non-JSON output does not block the script.
 */
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
    // Valid JSON but not an object (e.g., string, number, array) — ignore
    return null;
  } catch {
    return null;
  }
}

/**
 * Collects chunks from a ReadableStream, enforcing a maximum byte limit.
 * Once the limit is exceeded, the stream continues draining to avoid pipe
 * deadlock, but no further data is appended.
 */
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
        // Already exceeded limit — keep draining to avoid deadlock
        continue;
      }

      if (totalBytes + value.length > maxBytes) {
        // Take only what fits up to the limit
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
