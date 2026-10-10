import { join, normalize, relative } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';

export interface FileIndexEntry {
  path: string;
  name: string;
  type: 'file' | 'folder';
}

interface IgnorePattern {
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
  baseDir: string;
}

const BUILTIN_IGNORE_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

const UTF8_BOM = '\uFEFF';

function detectCaseSensitiveFs(workspacePath: string): boolean {
  const flipped = workspacePath.replace(/[a-zA-Z]/, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
  );
  if (flipped === workspacePath) return true;
  try {
    return statSync(flipped).ino !== statSync(workspacePath).ino;
  } catch {
    return true;
  }
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegexChar(ch: string): string {
  return /[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch;
}

function escapeRegexLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

function findCharClassEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '!' || pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  for (; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] === ']') return i;
  }
  return -1;
}

function translateCharClass(source: string): string {
  const end = source.length - 1;
  let i = 1;
  let negated = false;
  if (source[i] === '!' || source[i] === '^') {
    negated = true;
    i++;
  }

  let inner = '';
  for (; i < end; i++) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < end) {
      const next = source[i + 1];
      i++;
      if (next === '/') continue;
      inner += /[\\\]^-]/.test(next) ? `\\${next}` : next;
    } else if (ch === '/') {
      continue;
    } else {
      inner += /[\\\]^]/.test(ch) ? `\\${ch}` : ch;
    }
  }

  if (negated) return `[^${inner}/]`;
  return `[${inner}]`;
}

function globToRegexSource(pattern: string): string {
  let rx = '';
  let i = 0;
  let atSegmentStart = true;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      let j = i;
      while (pattern[j] === '*') j++;
      const doubles = j - i >= 2;
      const nextIsSlash = pattern[j] === '/';
      const nextIsEnd = j >= pattern.length;
      if (doubles && atSegmentStart && (nextIsSlash || nextIsEnd)) {
        if (nextIsSlash) {
          rx += '(?:.*/)?';
          i = j + 1;
          atSegmentStart = true;
        } else {
          rx += '.*';
          i = j;
          atSegmentStart = false;
        }
      } else {
        rx += '[^/]*';
        i = j;
        atSegmentStart = false;
      }
    } else if (ch === '?') {
      rx += '[^/]';
      i++;
      atSegmentStart = false;
    } else if (ch === '[') {
      const end = findCharClassEnd(pattern, i);
      if (end === -1) {
        rx += '\\[';
        i++;
      } else {
        rx += translateCharClass(pattern.slice(i, end + 1));
        i = end + 1;
      }
      atSegmentStart = false;
    } else if (ch === '\\') {
      const next = pattern[i + 1];
      rx += next === undefined ? '\\\\' : escapeRegexLiteral(next);
      i += next === undefined ? 1 : 2;
      atSegmentStart = false;
    } else {
      rx += escapeRegexChar(ch);
      i++;
      atSegmentStart = ch === '/';
    }
  }
  return rx;
}

function stripTrailingWhitespace(line: string): string {
  let end = line.length;
  if (end > 0 && line[end - 1] === '\r') end--;
  while (end > 0) {
    const ch = line[end - 1];
    if (ch !== ' ' && ch !== '\t') break;
    let backslashes = 0;
    let k = end - 2;
    while (k >= 0 && line[k] === '\\') {
      backslashes++;
      k--;
    }
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

function parseGitignoreLines(
  lines: string[],
  baseDir: string,
  caseSensitive: boolean
): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (const rawLine of lines) {
    const stripped = rawLine.startsWith(UTF8_BOM) ? rawLine.slice(1) : rawLine;
    const line = stripTrailingWhitespace(stripped);
    if (!line || line.startsWith('#')) continue;

    let body = line;
    const negated = body.startsWith('!');
    if (negated) body = body.slice(1);

    const dirOnly = body.endsWith('/');
    if (dirOnly) body = body.slice(0, -1);

    if (!body) continue;

    const anchored = body.startsWith('/') || body.includes('/');
    if (body.startsWith('/')) body = body.slice(1);
    if (!body) continue;

    const source = globToRegexSource(body);
    let regex: RegExp;
    try {
      regex = new RegExp(
        anchored ? `^${source}$` : `^(?:.*/)?${source}$`,
        caseSensitive ? '' : 'i'
      );
    } catch {
      continue;
    }

    patterns.push({ regex, negated, dirOnly, baseDir });
  }

  return patterns;
}

function relativeToBase(relPath: string, baseDir: string): string | null {
  if (baseDir === '') return relPath;
  if (relPath === baseDir) return null;
  if (relPath.startsWith(`${baseDir}/`)) return relPath.slice(baseDir.length + 1);
  return null;
}

function patternMatches(pattern: IgnorePattern, relToBase: string, isDirectory: boolean): boolean {
  if (!pattern.regex.test(relToBase)) return false;
  return !pattern.dirOnly || isDirectory;
}

function shouldIgnore(relPath: string, isDirectory: boolean, patterns: IgnorePattern[]): boolean {
  const segments = relPath.split('/');

  for (const seg of segments) {
    if (BUILTIN_IGNORE_NAMES.has(seg)) return true;
  }

  let ignored = false;

  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    const isLast = i === segments.length;
    const prefixIsDir = isLast ? isDirectory : true;

    for (const pattern of patterns) {
      const relToBase = relativeToBase(prefix, pattern.baseDir);
      if (relToBase === null) continue;

      if (patternMatches(pattern, relToBase, prefixIsDir)) {
        ignored = !pattern.negated;
      }
    }

    if (!isLast && ignored) return true;
  }

  return ignored;
}

function scoreEntry(entry: FileIndexEntry, lowerQuery: string): number {
  const lowerName = entry.name.toLowerCase();
  const lowerPath = entry.path.toLowerCase();

  if (lowerName === lowerQuery) return 100;
  if (lowerName.startsWith(lowerQuery)) return 80;
  if (lowerName.includes(lowerQuery)) return 60;

  const segments = lowerPath.split('/');
  if (segments.some((s) => s.includes(lowerQuery))) return 40;

  if (lowerPath.includes(lowerQuery)) return 20;

  return 0;
}

function isSafePath(workspacePath: string, relPath: string): boolean {
  if (relPath.startsWith('/')) return false;

  const segments = relPath.split('/');
  if (segments.some((s) => s === '..')) return false;

  const normalizedWorkspace = normalize(workspacePath);
  const resolved = normalize(join(workspacePath, relPath));
  const rel = relative(normalizedWorkspace, resolved);

  return !rel.startsWith('..') && rel !== '..';
}

export class FileIndex {
  private cache = new Map<string, FileIndexEntry>();
  private ready = false;
  private scanning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private extraPatterns: IgnorePattern[] = [];
  private readonly pollInterval: number;
  private readonly caseSensitive: boolean;

  constructor(
    private readonly workspacePath: string | undefined,
    pollIntervalMs?: number,
    caseSensitive?: boolean
  ) {
    this.pollInterval =
      pollIntervalMs ?? parseInt(process.env.HYPERNEO_FILE_INDEX_POLL_MS ?? '60000', 10);
    this.caseSensitive =
      caseSensitive ?? (workspacePath ? detectCaseSensitiveFs(workspacePath) : true);
  }

  private async readDirPatterns(absDir: string, relDir: string): Promise<IgnorePattern[]> {
    const gitignorePath = join(absDir, '.gitignore');
    if (!existsSync(gitignorePath)) return [];
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      return parseGitignoreLines(content.split('\n'), relDir, this.caseSensitive);
    } catch {
      return [];
    }
  }

  private async scanDirectory(
    absDir: string,
    relDir: string,
    inherited: IgnorePattern[],
    seen: Set<string>
  ): Promise<void> {
    const local = await this.readDirPatterns(absDir, relDir);
    const patterns = local.length === 0 ? inherited : [...inherited, ...local];

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const active = [...patterns, ...this.extraPatterns];

    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = toPosix(relative(this.workspacePath!, absPath));

      if (!isSafePath(this.workspacePath!, relPath)) continue;

      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(absPath);
          const symType = targetStat.isDirectory() ? 'folder' : 'file';
          if (shouldIgnore(relPath, symType === 'folder', active)) continue;
          seen.add(relPath);
          if (!this.cache.has(relPath)) {
            this.cache.set(relPath, { path: relPath, name: entry.name, type: symType });
          }
        } catch {}
        continue;
      }

      const isDir = entry.isDirectory();
      if (shouldIgnore(relPath, isDir, active)) continue;

      seen.add(relPath);

      if (!this.cache.has(relPath)) {
        this.cache.set(relPath, {
          path: relPath,
          name: entry.name,
          type: isDir ? 'folder' : 'file',
        });
      }

      if (isDir) {
        await this.scanDirectory(absPath, relPath, patterns, seen);
      }
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.workspacePath === undefined) return;
    if (this.scanning) return;
    this.scanning = true;

    try {
      const seen = new Set<string>();
      await this.scanDirectory(this.workspacePath!, '', [], seen);

      for (const key of this.cache.keys()) {
        if (!seen.has(key)) {
          this.cache.delete(key);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  async init(): Promise<void> {
    if (this.workspacePath === undefined) {
      return;
    }
    await this.runRefresh();
    this.ready = true;

    this.pollTimer = setInterval(() => {
      void this.runRefresh();
    }, this.pollInterval);
    this.pollTimer.unref?.();
  }

  search(query: string, limit = 50): FileIndexEntry[] {
    if (!query) {
      const results: FileIndexEntry[] = [];
      for (const entry of this.cache.values()) {
        results.push(entry);
        if (results.length >= limit) break;
      }
      return results;
    }

    const lowerQuery = query.toLowerCase();
    const scored: Array<{ entry: FileIndexEntry; score: number }> = [];

    for (const entry of this.cache.values()) {
      const score = scoreEntry(entry, lowerQuery);
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.entry);
  }

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  async refresh(): Promise<void> {
    await this.runRefresh();
  }

  size(): number {
    return this.cache.size;
  }

  setIgnorePatterns(patterns: string[]): void {
    this.extraPatterns = parseGitignoreLines(patterns, '', this.caseSensitive);
    for (const [key, entry] of this.cache) {
      if (shouldIgnore(entry.path, entry.type === 'folder', this.extraPatterns)) {
        this.cache.delete(key);
      }
    }
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
