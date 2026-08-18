import type {
  MessageHub,
  ReferenceType,
  ReferenceSearchResult,
  ResolvedReference,
} from '@hyperneo/shared';
import type { SessionManager } from '../session-manager';
import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import type { ReactiveDatabase } from '../../storage/reactive-database';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { GoalRepository } from '../../storage/repositories/goal-repository';
import type { ShortIdAllocator } from '../short-id-allocator';
import type { FileIndex } from '../file-index';
import { FileManager } from '../file-manager';
import { Logger } from '../logger';
import { join, normalize, relative } from 'node:path';

const log = new Logger('reference-handlers');

const MAX_FILE_CONTENT_BYTES = 50_000;

const BINARY_DETECTION_SAMPLE_BYTES = 8_192;

const RESULTS_PER_CATEGORY = 10;

export interface TaskRepoForReference {
  getTask(id: string): unknown | null;
  getTaskByShortId(roomId: string, shortId: string): unknown | null;
}

export interface GoalRepoForReference {
  getGoal(id: string): unknown | null;
  getGoalByShortId(roomId: string, shortId: string): unknown | null;
}

export interface ReferenceHandlerDeps {
  db: BunDatabase;
  reactiveDb: ReactiveDatabase;
  shortIdAllocator: ShortIdAllocator;
  sessionManager: SessionManager;
  taskRepo: TaskRepoForReference;
  goalRepo: GoalRepoForReference;
  workspaceRoot?: string;
  fileIndex: FileIndex;
}

function scoreResult(displayText: string, query: string): number {
  const t = displayText.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 4;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  return 1;
}

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

export function setupReferenceHandlers(messageHub: MessageHub, deps: ReferenceHandlerDeps): void {
  const { db, reactiveDb, shortIdAllocator, sessionManager, fileIndex } = deps;

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
            log.warn(`Unknown reference type: ${params.type as string}`);
            return { resolved: null };
          }
        }
      } catch (err) {
        log.warn(`Failed to resolve reference ${params.type}:${params.id}:`, err);
        return { resolved: null };
      }
    }
  );

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

    if (!query && !roomId) return { results: [] };

    const allResults: ReferenceSearchResult[] = [];

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
    }

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
    }

    const fileTypes: Array<'file' | 'folder'> = [];
    if (requestedTypes.includes('file')) fileTypes.push('file');
    if (requestedTypes.includes('folder')) fileTypes.push('folder');

    if (fileTypes.length > 0 && query.length > 0) {
      if (query.includes('..') || query.startsWith('/')) {
        return { results: allResults };
      }

      try {
        const fileEntries = fileIndex.search(query, RESULTS_PER_CATEGORY * fileTypes.length * 2);
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

  messageHub.onRequest('fileindex.rescan', async () => {
    await fileIndex.refresh();
    return { size: fileIndex.size() };
  });
}

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

async function resolveTask(
  id: string,
  roomId: string | null,
  deps: ReferenceHandlerDeps
): Promise<ResolvedReference | null> {
  let task = deps.taskRepo.getTask(id);
  if (!task && roomId) {
    task = deps.taskRepo.getTaskByShortId(roomId, id);
  }

  if (!task) {
    return null;
  }

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
  let goal = deps.goalRepo.getGoal(id);
  if (!goal && roomId) {
    goal = deps.goalRepo.getGoalByShortId(roomId, id);
  }

  if (!goal) {
    return null;
  }

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

  let absolutePath: string;
  try {
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

  let isBinary = false;
  let fileSize = 0;
  let fileMtime = '';
  try {
    const { stat } = await import('node:fs/promises');
    const stats = await stat(absolutePath);
    fileSize = stats.size;
    fileMtime = stats.mtime.toISOString();

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
    return null;
  }

  if (isBinary) {
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
