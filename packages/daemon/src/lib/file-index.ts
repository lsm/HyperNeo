import { join, normalize, relative } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface FileIndexEntry {
  path: string;
  name: string;
  type: 'file' | 'folder';
}

interface IgnorePattern {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
}

const BUILTIN_IGNORE_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

function parseGitignoreLines(lines: string[]): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    let pattern = line;
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);

    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    if (!pattern) continue;

    patterns.push({ pattern, negated, dirOnly });
  }

  return patterns;
}

function buildGlobRegex(pattern: string): string {
  let rx = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i += 2;
      if (pattern[i] === '/') {
        i++;
        rx += '(?:.*/)?';
      } else {
        rx += '.*';
      }
    } else if (ch === '*') {
      rx += '[^/]*';
      i++;
    } else if (ch === '?') {
      rx += '[^/]';
      i++;
    } else {
      let esc = ch;
      if (ch === '.') esc = '\\.';
      else if (ch === '+') esc = '\\+';
      else if (ch === '^') esc = '\\^';
      else if (ch === '$') esc = '\\$';
      else if (ch === '{') esc = '\\{';
      else if (ch === '}') esc = '\\}';
      else if (ch === '(') esc = '\\(';
      else if (ch === ')') esc = '\\)';
      else if (ch === '|') esc = '\\|';
      else if (ch === '[') esc = '\\[';
      else if (ch === ']') esc = '\\]';
      else if (ch === '\\') esc = '\\\\';
      rx += esc;
      i++;
    }
  }
  return rx;
}

function matchSegment(pattern: string, segment: string): boolean {
  const rx = new RegExp('^' + buildGlobRegex(pattern) + '$', 'i');
  return rx.test(segment);
}

function matchFullPath(pattern: string, relPath: string): boolean {
  const rx = new RegExp('^' + buildGlobRegex(pattern) + '$', 'i');
  return rx.test(relPath);
}

function shouldIgnore(relPath: string, isDirectory: boolean, patterns: IgnorePattern[]): boolean {
  const segments = relPath.split('/');

  for (const seg of segments) {
    if (BUILTIN_IGNORE_NAMES.has(seg)) return true;
  }

  let ignored = false;

  for (const { pattern, negated, dirOnly } of patterns) {
    if (dirOnly && !isDirectory) continue;

    let matches = false;

    if (pattern.includes('/')) {
      matches = matchFullPath(pattern, relPath);
    } else {
      matches = segments.some((seg) => matchSegment(pattern, seg));
    }

    if (matches) {
      ignored = !negated;
    }
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
  private ignorePatterns: IgnorePattern[] = [];
  private extraPatterns: IgnorePattern[] = [];
  private readonly pollInterval: number;

  constructor(
    private readonly workspacePath: string | undefined,
    pollIntervalMs?: number
  ) {
    this.pollInterval =
      pollIntervalMs ?? parseInt(process.env.HYPERNEO_FILE_INDEX_POLL_MS ?? '60000', 10);
  }

  private async loadGitignore(): Promise<void> {
    const gitignorePath = join(this.workspacePath!, '.gitignore');
    try {
      if (!existsSync(gitignorePath)) return;
      const content = await readFile(gitignorePath, 'utf-8');
      this.ignorePatterns = parseGitignoreLines(content.split('\n'));
    } catch {}
  }

  private get allPatterns(): IgnorePattern[] {
    return [...this.ignorePatterns, ...this.extraPatterns];
  }

  private async scanDirectory(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = relative(this.workspacePath!, absPath);

      if (!isSafePath(this.workspacePath!, relPath)) continue;

      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(absPath);
          const symType = targetStat.isDirectory() ? 'folder' : 'file';
          if (shouldIgnore(relPath, symType === 'folder', this.allPatterns)) continue;
          this.cache.set(relPath, { path: relPath, name: entry.name, type: symType });
        } catch {}
        continue;
      }

      const isDir = entry.isDirectory();
      if (shouldIgnore(relPath, isDir, this.allPatterns)) continue;

      this.cache.set(relPath, {
        path: relPath,
        name: entry.name,
        type: isDir ? 'folder' : 'file',
      });

      if (isDir) {
        await this.scanDirectory(absPath);
      }
    }
  }

  private async refreshDirectory(absDir: string, seen: Set<string>): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = relative(this.workspacePath!, absPath);

      if (!isSafePath(this.workspacePath!, relPath)) continue;

      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(absPath);
          const symType = targetStat.isDirectory() ? 'folder' : 'file';
          if (shouldIgnore(relPath, symType === 'folder', this.allPatterns)) continue;
          seen.add(relPath);
          if (!this.cache.has(relPath)) {
            this.cache.set(relPath, { path: relPath, name: entry.name, type: symType });
          }
        } catch {}
        continue;
      }

      const isDir = entry.isDirectory();
      if (shouldIgnore(relPath, isDir, this.allPatterns)) continue;

      seen.add(relPath);

      if (!this.cache.has(relPath)) {
        this.cache.set(relPath, {
          path: relPath,
          name: entry.name,
          type: isDir ? 'folder' : 'file',
        });
      }

      if (isDir) {
        await this.refreshDirectory(absPath, seen);
      }
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.workspacePath === undefined) return;
    if (this.scanning) return;
    this.scanning = true;

    try {
      const seen = new Set<string>();
      await this.refreshDirectory(this.workspacePath!, seen);

      for (const key of this.cache.keys()) {
        if (!seen.has(key)) {
          this.cache.delete(key);
        }
      }

      for (const [key, entry] of this.cache) {
        if (shouldIgnore(entry.path, entry.type === 'folder', this.allPatterns)) {
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
    await this.loadGitignore();
    await this.scanDirectory(this.workspacePath!);
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
    this.extraPatterns = parseGitignoreLines(patterns);
    for (const [key, entry] of this.cache) {
      if (shouldIgnore(entry.path, entry.type === 'folder', this.allPatterns)) {
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
