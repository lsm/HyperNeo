/**
 * File Index -- Workspace file tree cache with polling-based refresh.
 *
 * Scans the workspace once on init(), maintains an in-memory cache of all
 * file and folder entries, and refreshes the cache incrementally via polling.
 * Designed for fast fuzzy search without recursive directory listing on every query.
 *
 * Notes:
 * - Symbolic links are indexed (as file or folder depending on their target type)
 *   but symlinked directories are NOT recursed into, to prevent infinite loops.
 * - Calling setIgnorePatterns() immediately re-filters the cache.
 * - The polling interval is configurable via NEOKAI_FILE_INDEX_POLL_MS (default 60000 ms).
 */

import { join, normalize, relative } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface FileIndexEntry {
  /** Relative path from workspace root (e.g. "src/utils/helper.ts") */
  path: string;
  /** File or directory name (e.g. "helper.ts") */
  name: string;
  type: 'file' | 'folder';
}

interface IgnorePattern {
  /** Glob pattern string (after stripping negation prefix and dir suffix) */
  pattern: string;
  negated: boolean;
  /** True if the pattern only applies to directories */
  dirOnly: boolean;
}

// Always-ignored names regardless of .gitignore
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

/**
 * Build a regex string from a glob pattern (without anchors).
 *
 * Supported wildcards:
 *   "**" followed by "/" -- matches any depth including zero (e.g. tests at root or nested)
 *   "**" elsewhere       -- matches any character sequence
 *   "*"                  -- matches any characters except "/"
 *   "?"                  -- matches exactly one character except "/"
 *   other chars          -- matched literally
 */
function buildGlobRegex(pattern: string): string {
  let rx = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i += 2;
      if (pattern[i] === '/') {
        i++;
        // "**/prefix" matches at any depth including root -- use optional group
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
      // Escape standard regex metacharacters one by one (avoids regex inside regex)
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

/**
 * Match a single path segment against a glob pattern (no "/" in segment).
 * Used for floating patterns that apply to any path component.
 */
function matchSegment(pattern: string, segment: string): boolean {
  const rx = new RegExp('^' + buildGlobRegex(pattern) + '$', 'i');
  return rx.test(segment);
}

/**
 * Match a full relative path against a glob pattern.
 * Used for anchored patterns that contain "/".
 */
function matchFullPath(pattern: string, relPath: string): boolean {
  const rx = new RegExp('^' + buildGlobRegex(pattern) + '$', 'i');
  return rx.test(relPath);
}

function shouldIgnore(relPath: string, isDirectory: boolean, patterns: IgnorePattern[]): boolean {
  const segments = relPath.split('/');

  // Always ignore built-in names at any depth
  for (const seg of segments) {
    if (BUILTIN_IGNORE_NAMES.has(seg)) return true;
  }

  let ignored = false;

  for (const { pattern, negated, dirOnly } of patterns) {
    if (dirOnly && !isDirectory) continue;

    let matches = false;

    if (pattern.includes('/')) {
      // Anchored pattern: match against full relative path
      matches = matchFullPath(pattern, relPath);
    } else {
      // Floating pattern: match against any path segment
      matches = segments.some((seg) => matchSegment(pattern, seg));
    }

    if (matches) {
      ignored = !negated;
    }
  }

  return ignored;
}

/**
 * Score a search result. Higher is better.
 *  100 -- exact name match (case-insensitive)
 *   80 -- name starts with query
 *   60 -- name contains query (name-level matches always beat path-level)
 *   40 -- any path segment contains query
 *   20 -- full path contains query
 *    0 -- no match
 */
function scoreEntry(entry: FileIndexEntry, lowerQuery: string): number {
  const lowerName = entry.name.toLowerCase();
  const lowerPath = entry.path.toLowerCase();

  if (lowerName === lowerQuery) return 100;
  if (lowerName.startsWith(lowerQuery)) return 80;
  if (lowerName.includes(lowerQuery)) return 60;

  // Check individual path segments
  const segments = lowerPath.split('/');
  if (segments.some((s) => s.includes(lowerQuery))) return 40;

  if (lowerPath.includes(lowerQuery)) return 20;

  return 0;
}

/**
 * Prevent path traversal: return true if the path is safe to use.
 */
function isSafePath(workspacePath: string, relPath: string): boolean {
  // Reject absolute paths
  if (relPath.startsWith('/')) return false;

  // Reject paths with .. segments
  const segments = relPath.split('/');
  if (segments.some((s) => s === '..')) return false;

  // Double-check by resolving and comparing
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
      pollIntervalMs ?? parseInt(process.env.NEOKAI_FILE_INDEX_POLL_MS ?? '60000', 10);
  }

  /** Load .gitignore from workspace root if it exists. */
  private async loadGitignore(): Promise<void> {
    const gitignorePath = join(this.workspacePath!, '.gitignore');
    try {
      if (!existsSync(gitignorePath)) return;
      const content = await readFile(gitignorePath, 'utf-8');
      this.ignorePatterns = parseGitignoreLines(content.split('\n'));
    } catch {
      // Non-fatal: continue without .gitignore patterns
    }
  }

  /** Combined ignore patterns (gitignore + extra). */
  private get allPatterns(): IgnorePattern[] {
    return [...this.ignorePatterns, ...this.extraPatterns];
  }

  /** Recursively scan a directory and populate the cache. */
  private async scanDirectory(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // Permission errors or missing dirs -- skip silently
      return;
    }

    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = relative(this.workspacePath!, absPath);

      if (!isSafePath(this.workspacePath!, relPath)) continue;

      // Resolve symlinks: stat() follows the link to get the target type.
      // Symlinked directories are NOT recursed into to prevent infinite loops.
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(absPath);
          const symType = targetStat.isDirectory() ? 'folder' : 'file';
          if (shouldIgnore(relPath, symType === 'folder', this.allPatterns)) continue;
          this.cache.set(relPath, { path: relPath, name: entry.name, type: symType });
        } catch {
          // Broken symlink -- skip
        }
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

  /**
   * Incremental refresh: walk the workspace and sync the cache.
   * Adds new entries, removes stale ones, and re-evaluates existing entries
   * against the current ignore patterns (handles setIgnorePatterns calls).
   */
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

      // Resolve symlinks: stat() follows the link; do NOT recurse into symlinked dirs.
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(absPath);
          const symType = targetStat.isDirectory() ? 'folder' : 'file';
          if (shouldIgnore(relPath, symType === 'folder', this.allPatterns)) continue;
          seen.add(relPath);
          if (!this.cache.has(relPath)) {
            this.cache.set(relPath, { path: relPath, name: entry.name, type: symType });
          }
        } catch {
          // Broken symlink -- skip
        }
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

  /** Run a full incremental refresh scan. */
  private async runRefresh(): Promise<void> {
    // Guard: no-op when workspacePath is not set (mirrors the init() guard).
    // Prevents non-null assertions below from firing if this method is ever
    // called before init() completes or via an unexpected code path.
    if (this.workspacePath === undefined) return;
    if (this.scanning) return; // Skip if previous scan is still running
    this.scanning = true;

    try {
      const seen = new Set<string>();
      await this.refreshDirectory(this.workspacePath!, seen);

      // Remove entries that no longer exist on disk
      for (const key of this.cache.keys()) {
        if (!seen.has(key)) {
          this.cache.delete(key);
        }
      }

      // Re-evaluate remaining entries against current patterns.
      // This ensures entries added before a setIgnorePatterns() call are purged.
      for (const [key, entry] of this.cache) {
        if (shouldIgnore(entry.path, entry.type === 'folder', this.allPatterns)) {
          this.cache.delete(key);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Perform the initial workspace scan.
   * Must be called before search(). Starts the background polling timer.
   *
   * When no workspace path was provided at construction time, this is a no-op:
   * the index remains empty and search() will return no results.
   */
  async init(): Promise<void> {
    // Guard: no-op when no workspace path is set (daemon started without --workspace).
    // The index degrades gracefully — search() returns empty results.
    if (this.workspacePath === undefined) {
      return;
    }
    await this.loadGitignore();
    await this.scanDirectory(this.workspacePath!);
    this.ready = true;

    // Start background polling
    this.pollTimer = setInterval(() => {
      void this.runRefresh();
    }, this.pollInterval);
    this.pollTimer.unref?.();
  }

  /**
   * Fuzzy-search cached entries by name and path.
   * Returns results sorted by relevance score, highest first.
   *
   * @param query  Search string (case-insensitive)
   * @param limit  Maximum number of results (default: 50)
   */
  search(query: string, limit = 50): FileIndexEntry[] {
    if (!query) {
      // Return first entries when query is empty
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

  /**
   * Remove a single path from the cache.
   * Useful when a file/folder is known to be deleted or moved.
   */
  invalidate(path: string): void {
    this.cache.delete(path);
  }

  /** Clear the entire cache. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Whether the initial scan has completed. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Trigger an immediate incremental refresh scan.
   * Useful when files are created/deleted and the caller cannot wait
   * for the next polling cycle (e.g. E2E test setup).
   *
   * No-op if a scan is already in progress or no workspace is configured.
   */
  async refresh(): Promise<void> {
    await this.runRefresh();
  }

  /** Number of entries currently in the cache (useful for testing). */
  size(): number {
    return this.cache.size;
  }

  /**
   * Set additional ignore patterns at runtime.
   * These are layered on top of .gitignore patterns.
   *
   * Immediately re-filters the cache: entries that now match the updated patterns
   * are removed from the cache right away, without waiting for the next poll.
   */
  setIgnorePatterns(patterns: string[]): void {
    this.extraPatterns = parseGitignoreLines(patterns);
    // Re-filter the cache immediately against the updated patterns
    for (const [key, entry] of this.cache) {
      if (shouldIgnore(entry.path, entry.type === 'folder', this.allPatterns)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Stop the background polling timer and release resources.
   * Must be called when the index is no longer needed.
   */
  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
