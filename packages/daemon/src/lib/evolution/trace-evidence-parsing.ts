const SOURCE_FILE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'cpp',
  'c',
  'h',
  'md',
  'json',
  'yml',
  'yaml',
  'toml',
  'css',
  'html',
]);

export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s\n\r,:"'`()[\]{}]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const ext = trimmed.split('.').pop()?.toLowerCase() ?? '';
    if (!SOURCE_FILE_EXTENSIONS.has(ext)) continue;
    const looksLikeFile =
      trimmed.includes('/') || trimmed.includes('\\') || /^[\w.-]+\.[a-zA-Z0-9]+$/.test(trimmed);
    if (!looksLikeFile) continue;
    const short = trimmed.slice(0, 120);
    if (seen.has(short)) continue;
    seen.add(short);
    paths.push(short);
  }
  return paths;
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').slice(0, 160);
}

export function normalizeErrorFingerprint(text: string): string {
  const normalized = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .slice(0, 180);
  return normalized || 'unknown tool failure';
}

export function extractToolResultText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const block = asRecord(item);
      if (!block) return '';
      return typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function readContent(message: Record<string, unknown>): unknown {
  const nested = asRecord(message.message);
  return nested?.content;
}

export function readFilePath(input: Record<string, unknown>): string | null {
  const candidates = [input.file_path, input.notebook_path, input.path];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function plural(count: number): string {
  return count === 1 ? '' : 's';
}
