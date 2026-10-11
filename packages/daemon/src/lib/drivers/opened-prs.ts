const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const PR_ARTIFACT =
  /attach_artifact[^)]*?pull_request[^)]*?(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)/g;
export const WORK_OPENED_PRS_MAX = 10;

export function keepOpenedPrs(urls: readonly string[]): string[] {
  const kept = new Map<string, string>();
  for (const url of urls) {
    kept.delete(url.toLowerCase());
    kept.set(url.toLowerCase(), url);
  }
  return [...kept.values()].slice(-WORK_OPENED_PRS_MAX);
}

const relevant = (line: string) => line.includes('/pull/') || PR_CREATE.test(line);

const urlsIn = (value: unknown) =>
  (typeof value === 'string' ? value : JSON.stringify(value ?? '')).match(PR_URL) ?? [];

function parse(line: string): Record<string, unknown> | null {
  try {
    const entry = JSON.parse(line) as unknown;
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function claudeOpenedPrs(lines: readonly string[]): string[] {
  if (!lines.some((line) => PR_CREATE.test(line))) return [];
  const creating = new Set<unknown>();
  const urls: string[] = [];
  for (const line of lines.filter(relevant)) {
    const content = (parse(line)?.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type === 'tool_use' && PR_CREATE.test(JSON.stringify(part.input ?? '')))
        creating.add(part.id);
      if (part?.type === 'tool_result' && creating.has(part.tool_use_id))
        urls.push(...urlsIn(part.content));
    }
  }
  return keepOpenedPrs(urls);
}

export function codexOpenedPrs(lines: readonly string[]): string[] {
  if (!lines.some((line) => PR_CREATE.test(line) || line.includes('attach_artifact'))) return [];
  const creating = new Set<unknown>();
  const urls: string[] = [];
  for (const line of lines.filter(relevant)) {
    urls.push(...[...line.matchAll(PR_ARTIFACT)].map((match) => match[1]!));
    const entry = parse(line);
    const payload = (entry?.payload ?? {}) as Record<string, unknown>;
    if (entry?.type !== 'response_item' || typeof payload.type !== 'string') continue;
    if (payload.type.endsWith('_call') && PR_CREATE.test(JSON.stringify(payload)))
      creating.add(payload.call_id);
    if (payload.type.endsWith('_call_output') && creating.has(payload.call_id))
      urls.push(...urlsIn(payload.output));
  }
  return keepOpenedPrs(urls);
}
