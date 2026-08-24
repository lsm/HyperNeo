import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';
import type { ReadFileRequest, ListFilesRequest, GetFileTreeRequest } from '@hyperneo/shared';
import { FileManager } from '../file-manager.ts';

export function setupFileHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
  const getBoundWorkspacePath = (targetSessionId: string): string => {
    const session = sessionManager.getSessionFromDB(targetSessionId);
    if (!session) throw new Error('Session not found');
    const workspacePath = session.worktree?.worktreePath ?? session.workspacePath;
    if (!workspacePath) {
      throw new Error('Session has no bound workspace path');
    }
    return workspacePath;
  };

  messageHub.onRequest('file.read', async (data) => {
    const {
      sessionId: targetSessionId,
      path,
      encoding,
    } = data as ReadFileRequest & { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const fileManager = new FileManager(getBoundWorkspacePath(targetSessionId));
    const fileData = await fileManager.readFile(path, encoding as 'utf-8' | 'base64');

    return fileData;
  });

  messageHub.onRequest('file.list', async (data) => {
    const {
      sessionId: targetSessionId,
      path,
      recursive,
    } = data as ListFilesRequest & { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const fileManager = new FileManager(getBoundWorkspacePath(targetSessionId));
    const files = await fileManager.listDirectory(path || '.', recursive);

    return { files };
  });

  messageHub.onRequest('file.tree', async (data) => {
    const {
      sessionId: targetSessionId,
      path,
      maxDepth,
    } = data as GetFileTreeRequest & { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(targetSessionId);
    if (!agentSession) {
      throw new Error('Session not found');
    }

    const fileManager = new FileManager(getBoundWorkspacePath(targetSessionId));
    const tree = await fileManager.getFileTree(path || '.', maxDepth || 3);

    return { tree };
  });
}
