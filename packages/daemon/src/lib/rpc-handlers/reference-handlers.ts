/**
 * Reference RPC Handlers
 *
 * RPC handlers for the @ reference system:
 * - reference.resolve — Resolve a single reference to its full entity data
 * - reference.search — search tasks, goals, files, and folders by query string
 */

import type {
  MessageHub,
  ReferenceType,
  ReferenceSearchResult,
  ResolvedReference,
} from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { ReactiveDatabase } from '../../storage/reactive-database';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { GoalRepository } from '../../storage/repositories/goal-repository';
import type { ShortIdAllocator } from '../short-id-allocator';
import type { FileIndex } from '../file-index';
import { FileManager } from '../file-manager';
import { Logger } from '../logger';
import { join, normalize, relative } from 'node:path';

const log = new Logger('reference-handlers');

/**
 * Maximum number of bytes to include in file content payloads.
 * Files larger than this will be truncated to prevent oversized responses.
 */
const MAX_FILE_CONTENT_BYTES = 50_000;

/**
 * Number of bytes to sample when detecting binary files.
 * Checking the first 8 KB is sufficient for reliable binary detection.
 */
const BINARY_DETECTION_SAMPLE_BYTES = 8_192;

const RESULTS_PER_CATEGORY = 10;

// ============================================================================
// Repository interfaces (minimal — only what this handler needs)
// ============================================================================

export interface TaskRepoForReference {
  getTask(id: string): unknown | null;
  getTaskByShortId(roomId: string, shortId: string): unknown | null;
}

export interface GoalRepoForReference {
  getGoal(id: string): unknown | null;
  getGoalByShortId(roomId: string, shortId: string): unknown | null;
}

// ============================================================================
// Handler dependencies
// ============================================================================

export interface ReferenceHandlerDeps {
  /** Raw SQLite database (used to instantiate repositories for reference.search) */
  db: BunDatabase;
  /** Reactive database (passed to repositories; only used on writes — safe for read-only search) */
  reactiveDb: ReactiveDatabase;
  /**
   * Short ID allocator — enables lazy backfill of shortIds for tasks/goals that haven't been
   * viewed via task.list/goal.list yet. Without this, some results may lack their shortId.
   */
  shortIdAllocator: ShortIdAllocator;
  /** Session manager — used to look up session workspace path and room context */
  sessionManager: SessionManager;
  /** Task repository for looking up room tasks (reference.resolve) */
  taskRepo: TaskRepoForReference;
  /** Goal repository (not scoped to room — uses global DB access) */
  goalRepo: GoalRepoForReference;
  /** Workspace root path — used as fallback when no session is provided (optional) */
  workspaceRoot?: string;
  /** File index for fast file/folder search (reference.search) */
  fileIndex: FileIndex;
}

// ============================================================================
// Relevance scoring helpers (reference.search)
// ============================================================================

/** Relevance score used for sorting across categories. */
function scoreResult(displayText: string, query: string): number {
  const t = displayText.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  return 1;
}

/** Filter a list of ReferenceSearchResult by query and return top N sorted by relevance. */
function filterAndSort(
  results: ReferenceSearchResult[],
  query: string,
  limit: number
): ReferenceSearchResult[] {
  const q = query.toLowerCase();
  const scored = results
    .filter((r) => {
      const t = r.displayText.toLowerCase();
      const s = (r.subtitle ?? '').toLowerCase();
      return t.includes(q) || s.includes(q);
    })
    .map((r) => ({ r, score: scoreResult(r.displayText, query) }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.r);
}

// ============================================================================
// Main setup function
// ============================================================================

/**
 * Register reference RPC handlers on the MessageHub.
 */
export function setupReferenceHandlers(messageHub: MessageHub, deps: ReferenceHandlerDeps): void {
  const { db, reactiveDb, shortIdAllocator, sessionManager, fileIndex } = deps;

  // ------------------------------------------------------------------
  // reference.resolve
  // ------------------------------------------------------------------
  messageHub.onRequest(
    'reference.resolve',
    async (
      data
    ): Promise<{
      resolved: ResolvedReference | null;
    }> => {
      const params = data as {
        sessionId: string;
        type: ReferenceType;
        id: string;
      };

      if (!params.sessionId) {
        throw new Error('sessionId is required');
      }
      if (!params.type) {
        throw new Error('type is required');
      }
      if (!params.id) {
        throw new Error('id is required');
      }

      // Determine session context (workspace path + optional room ID)
      const { workspacePath, roomId } = await resolveSessionContext(params.sessionId, deps);

      try {
        switch (params.type) {
          case 'task':
            return { resolved: await resolveTask(params.id, roomId, deps) };

          case 'goal':
            return { resolved: resolveGoal(params.id, roomId, deps) };

          case 'file':
            if (!workspacePath) return { resolved: null };
            return { resolved: await resolveFile(params.id, workspacePath) };

          case 'folder':
            if (!workspacePath) return { resolved: null };
            return { resolved: await resolveFolder(params.id, workspacePath) };

          default: {
            // Exhaustiveness guard — unknown types return null rather than throwing
            log.warn(`Unknown reference type: ${params.type as string}`);
            return { resolved: null };
          }
        }
      } catch (err) {
        // Log unexpected errors but surface null so callers handle gracefully
        log.warn(`Failed to resolve reference ${params.type}:${params.id}:`, err);
        return { resolved: null };
      }
    }
  );

  // ------------------------------------------------------------------
  // reference.search
  // ------------------------------------------------------------------

  /**
   * reference.search — search across tasks, goals, files, and folders.
   *
   * Parameters:
   *   sessionId: string        — used to resolve room context
   *   query:     string        — search query
   *   types?:    ReferenceType[] — filter to specific types (default: all)
   *
   * Returns: { results: ReferenceSearchResult[] }
   */
  messageHub.onRequest('reference.search', async (data) => {
    const params = data as {
      sessionId: string;
      query: string;
      types?: ReferenceType[];
    };

    if (!params.sessionId) throw new Error('sessionId is required');
    if (typeof params.query !== 'string') throw new Error('query must be a string');

    const query = params.query.trim();

    const requestedTypes: ReferenceType[] =
      params.types && params.types.length > 0 ? params.types : ['task', 'goal', 'file', 'folder'];

    const session = sessionManager.getSessionFromDB(params.sessionId);
    const roomId = session?.context?.roomId;

    // Empty query with no room context: nothing to search.
    // Empty query WITH room context: return all tasks/goals for the room.
    if (!query && !roomId) return { results: [] };

    const allResults: ReferenceSearchResult[] = [];

    // ── Task search ───────────────────────────────────────────────────────
    if (requestedTypes.includes('task')) {
      if (roomId) {
        try {
          const taskRepo = new TaskRepository(db, reactiveDb, shortIdAllocator);
          const tasks = taskRepo.listTasks(roomId);
          const taskResults: ReferenceSearchResult[] = tasks.map((t) => ({
            type: 'task' as const,
            id: t.id,
            shortId: t.shortId ?? undefined,
            displayText: t.title,
            subtitle: t.status,
          }));
          allResults.push(...filterAndSort(taskResults, query, RESULTS_PER_CATEGORY));
        } catch (err) {
          log.warn('Failed to search tasks:', err);
        }
      }
      // No room context → skip task results silently
    }

    // ── Goal search ───────────────────────────────────────────────────────
    if (requestedTypes.includes('goal')) {
      if (roomId) {
        try {
          const goalRepo = new GoalRepository(db, reactiveDb, shortIdAllocator);
          const goals = goalRepo.listGoals(roomId);
          const goalResults: ReferenceSearchResult[] = goals.map((g) => ({
            type: 'goal' as const,
            id: g.id,
            shortId: g.shortId ?? undefined,
            displayText: g.title,
            subtitle: g.status,
          }));
          allResults.push(...filterAndSort(goalResults, query, RESULTS_PER_CATEGORY));
        } catch (err) {
          log.warn('Failed to search goals:', err);
        }
      }
      // No room context → skip goal results silently
    }

    // ── File / Folder search ──────────────────────────────────────────────
    const fileTypes: Array<'file' | 'folder'> = [];
    if (requestedTypes.includes('file')) fileTypes.push('file');
    if (requestedTypes.includes('folder')) fileTypes.push('folder');

    if (fileTypes.length > 0 && query.length > 0) {
      // Note: file/folder search requires a non-empty query — returning all files
      // on empty query would be too slow and noisy. Task/goal results above are
      // returned for empty queries since they are bounded to the room scope.
      // Path traversal check — reject queries with .. or absolute paths
      if (query.includes('..') || query.startsWith('/')) {
        // Return what we have so far without file results
        return { results: allResults };
      }

      try {
        // Fetch extra entries to account for post-search type filtering
        const fileEntries = fileIndex.search(query, RESULTS_PER_CATEGORY * fileTypes.length * 2);
        // Filter to requested types and enforce per-type limit
        const byType = new Map<string, number>([
          ['file', 0],
          ['folder', 0],
        ]);
        for (const e of fileEntries) {
          if (!fileTypes.includes(e.type as 'file' | 'folder')) continue;
          const count = byType.get(e.type) ?? 0;
          if (count >= RESULTS_PER_CATEGORY) continue;
          allResults.push({
            type: e.type as ReferenceType,
            id: e.path,
            displayText: e.name,
            subtitle: e.path,
          });
          byType.set(e.type, count + 1);
        }
      } catch (err) {
        log.warn('Failed to search file index:', err);
      }
    }

    return { results: allResults };
  });

  // ------------------------------------------------------------------
  // fileindex.rescan
  // ------------------------------------------------------------------

  /**
   * fileindex.rescan — trigger an immediate incremental refresh of the FileIndex.
   *
   * This is primarily useful for E2E tests that create workspace files and need
   * them indexed before searching. In normal operation, FileIndex polls automatically.
   *
   * Parameters: none
   * Returns: { size: number } — number of entries in the cache after refresh
   */
  messageHub.onRequest('fileindex.rescan', async () => {
    await fileIndex.refresh();
    return { size: fileIndex.size() };
  });
}

// ============================================================================
// Session context helper
// ============================================================================

/**
 * Resolve the workspace path and optional room ID for a given session ID.
 *
 * Falls back to the configured workspace root when the session cannot be loaded.
 */
async function resolveSessionContext(
  sessionId: string,
  deps: ReferenceHandlerDeps
): Promise<{ workspacePath: string | undefined; roomId: string | null }> {
  const agentSession = await deps.sessionManager.getSessionAsync(sessionId);
  if (!agentSession) {
    return { workspacePath: deps.workspaceRoot, roomId: null };
  }

  const sessionData = agentSession.getSessionData();
  return {
    workspacePath: sessionData.workspacePath ?? deps.workspaceRoot,
    roomId: sessionData.context?.roomId ?? null,
  };
}

// ============================================================================
// Per-type resolution helpers
// ============================================================================

async function resolveTask(
  id: string,
  roomId: string | null,
  deps: ReferenceHandlerDeps
): Promise<ResolvedReference | null> {
  // Support both UUID and short IDs (e.g. "t-42")
  let task = deps.taskRepo.getTask(id);
  if (!task && roomId) {
    task = deps.taskRepo.getTaskByShortId(roomId, id);
  }

  if (!task) {
    return null;
  }

  // When a room context is present, confirm the task belongs to that room
  // (prevent cross-room access via UUID). Without room context, UUID lookup
  // is allowed for global sessions (e.g. lobby).
  if (roomId && (task as { roomId?: string }).roomId !== roomId) {
    return null;
  }

  return {
    type: 'task',
    id,
    data: task,
  };
}

function resolveGoal(
  id: string,
  roomId: string | null,
  deps: ReferenceHandlerDeps
): ResolvedReference | null {
  // Support both UUID and short IDs (e.g. "g-7")
  let goal = deps.goalRepo.getGoal(id);
  if (!goal && roomId) {
    goal = deps.goalRepo.getGoalByShortId(roomId, id);
  }

  if (!goal) {
    return null;
  }

  // When a room context is present, confirm the goal belongs to that room
  // (prevent cross-room access via UUID). Without room context, UUID lookup
  // is allowed for global sessions (e.g. lobby).
  if (roomId && (goal as { roomId?: string }).roomId !== roomId) {
    return null;
  }

  return {
    type: 'goal',
    id,
    data: goal,
  };
}

export async function resolveFile(
  id: string,
  workspacePath: string
): Promise<ResolvedReference | null> {
  const fileManager = new FileManager(workspacePath);

  // Validate path (throws on traversal — we catch below to return null)
  let absolutePath: string;
  try {
    // Replicate FileManager path validation without reading the file yet
    const normalized = normalize(workspacePath);
    const resolved = normalize(join(workspacePath, id));
    const rel = relative(normalized, resolved);
    if (rel.startsWith('..') || rel === '..') {
      return null;
    }
    absolutePath = resolved;
  } catch {
    return null;
  }

  // Check for binary content before attempting text decode
  let isBinary = false;
  let fileSize = 0;
  let fileMtime = '';
  try {
    const { stat } = await import('node:fs/promises');
    const stats = await stat(absolutePath);
    fileSize = stats.size;
    fileMtime = stats.mtime.toISOString();

    // Sample the first BINARY_DETECTION_SAMPLE_BYTES bytes and check for null bytes,
    // which are the most reliable indicator of binary content.
    const sampleSize = Math.min(fileSize, BINARY_DETECTION_SAMPLE_BYTES);
    if (sampleSize > 0) {
      const buf = Buffer.allocUnsafe(sampleSize);
      const { open } = await import('node:fs/promises');
      const fd = await open(absolutePath, 'r');
      try {
        await fd.read(buf, 0, sampleSize, 0);
      } finally {
        await fd.close();
      }
      isBinary = buf.includes(0x00);
    }
  } catch {
    // File not found or unreadable
    return null;
  }

  if (isBinary) {
    // Return metadata only — content would be garbled and oversized
    return {
      type: 'file',
      id,
      data: {
        path: id,
        content: null,
        binary: true,
        truncated: false,
        size: fileSize,
        mtime: fileMtime,
      },
    };
  }

  // Read text content via FileManager (handles path validation internally)
  let fileData: {
    path: string;
    content: string;
    encoding: string;
    size: number;
    mtime: string;
  };

  try {
    fileData = await fileManager.readFile(id, 'utf-8');
  } catch {
    return null;
  }

  const rawContent = fileData.content;
  const truncated = rawContent.length > MAX_FILE_CONTENT_BYTES;
  const content = truncated ? rawContent.slice(0, MAX_FILE_CONTENT_BYTES) : rawContent;

  return {
    type: 'file',
    id,
    data: {
      path: fileData.path,
      content,
      binary: false,
      truncated,
      size: fileData.size,
      mtime: fileData.mtime,
    },
  };
}

export async function resolveFolder(
  id: string,
  workspacePath: string
): Promise<ResolvedReference | null> {
  const fileManager = new FileManager(workspacePath);

  let entries: Array<{ name: string; path: string; type: 'file' | 'directory' }>;

  try {
    const rawEntries = await fileManager.listDirectory(id, false);
    entries = rawEntries.map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type as 'file' | 'directory',
    }));
  } catch {
    // Directory not found or path traversal detected — return null
    return null;
  }

  return {
    type: 'folder',
    id,
    data: {
      path: id,
      entries,
    },
  };
}
