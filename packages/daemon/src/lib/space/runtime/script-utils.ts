/**
 * Generic script-execution utilities used by the v2 hook engine's custom-script
 * runner: JSON stdout parsing and max-buffer stream collection.
 */

/** Maximum stdout/stderr buffer size (1 MB). */
export const MAX_BUFFER_BYTES = 1_048_576;

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

  // Flush the streaming decoder: a multi-byte UTF-8 sequence split at the
  // final chunk boundary would otherwise be truncated (fail-closed stop on an
  // otherwise-valid script).
  chunks.push(decoder.decode());
  return { text: chunks.join(''), truncated };
}
