import { join, normalize, relative } from 'node:path';
import type {
  MessageHub,
  ReferenceSearchResult,
  ReferenceType,
  ResolvedReference,
} from '@hyperneo/shared';
import type { FileIndex } from '../file-index.ts';
import { FileManager } from '../file-manager.ts';
import { Logger } from '../logger.ts';
import type { SessionManager } from '../session-manager.ts';

const log = new Logger('reference-handlers');

const MAX_FILE_CONTENT_BYTES = 50_000;

const BINARY_DETECTION_SAMPLE_BYTES = 8_192;

const RESULTS_PER_CATEGORY = 10;

export interface ReferenceHandlerDeps {
  sessionManager: SessionManager;
  workspaceRoot?: string;
  fileIndex: FileIndex;
}

export function setupReferenceHandlers(messageHub: MessageHub, deps: ReferenceHandlerDeps): void {
  const { fileIndex } = deps;

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

      const workspacePath = await resolveSessionWorkspace(params.sessionId, deps);

      try {
        switch (params.type) {
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
      params.types && params.types.length > 0 ? params.types : ['file', 'folder'];

    if (!query) return { results: [] };

    const allResults: ReferenceSearchResult[] = [];

    const fileTypes: Array<'file' | 'folder'> = [];
    if (requestedTypes.includes('file')) fileTypes.push('file');
    if (requestedTypes.includes('folder')) fileTypes.push('folder');

    if (fileTypes.length > 0) {
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
}

async function resolveSessionWorkspace(
  sessionId: string,
  deps: ReferenceHandlerDeps
): Promise<string | undefined> {
  const agentSession = await deps.sessionManager.getSessionForControl(sessionId);
  if (!agentSession) return deps.workspaceRoot;
  return agentSession.getSessionData().workspacePath ?? deps.workspaceRoot;
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
