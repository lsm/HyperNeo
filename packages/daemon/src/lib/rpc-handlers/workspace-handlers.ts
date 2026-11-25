import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { MessageHub, WorkspaceHistoryEntry } from '@hyperneo/shared';
import type { McpImportService } from '../mcp/index.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { validateWorkspaceDirectory } from '../workspace-path.ts';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { identifyWorkspaces } from '../drivers/code-identity.ts';
import { mergePlaceGroups } from '../drivers/places.ts';
import type { Place } from '../drivers/types.ts';
import { neoRepositoryIdentity } from '../neo/project-mirror.ts';

const log = new Logger('workspace-handlers');

function repositoryKeys(place: Place): string[] {
  return [neoRepositoryIdentity(place.remotes?.[0]), place.codeIdentity].flatMap(
    (key) => key ?? []
  );
}

async function groupWorkspaceHistory(
  entries: WorkspaceHistoryEntry[]
): Promise<WorkspaceHistoryEntry[]> {
  const groups = await identifyWorkspaces(
    entries
      .filter((entry) => !entry.project)
      .map((entry) => ({
        place: { machine: '', folder: entry.path, name: basename(entry.path) },
        lastActivityAt: entry.lastUsedAt,
        openCount: 0,
        archivedCount: 0,
        adapters: [],
        work: [],
      }))
  );
  const projects = new Map<string, NonNullable<WorkspaceHistoryEntry['repositoryProject']>>();
  for (const group of mergePlaceGroups(groups, groups.length, repositoryKeys)) {
    const { projectId, workspaces } = group;
    if (!projectId || !workspaces || workspaces.length < 2) continue;
    const memberKeys = workspaces.map(repositoryKeys);
    const sharedKey = memberKeys[0].find((key) => memberKeys.every((keys) => keys.includes(key)));
    const digest = createHash('sha256')
      .update(sharedKey ?? projectId)
      .digest('hex');
    const project = {
      id: `repository:${digest}`,
      name: workspaces.map((place) => place.repoName ?? place.name).sort()[0],
    };
    for (const workspace of workspaces) {
      if (workspace.folder) projects.set(workspace.folder, project);
    }
  }
  return entries.map((entry) => {
    const repositoryProject = projects.get(entry.path);
    return repositoryProject ? { ...entry, repositoryProject } : entry;
  });
}

export function setupWorkspaceHandlers(
  messageHub: MessageHub,
  workspaceHistoryRepo: WorkspaceHistoryRepository,
  mcpImportService?: McpImportService,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): void {
  messageHub.onRequest('workspace.history', async (data) => {
    const entries = workspaceHistoryRepo.entries();
    const includeRepositoryProjects = (data as { includeRepositoryProjects?: boolean } | undefined)
      ?.includeRepositoryProjects;
    return {
      entries: includeRepositoryProjects === true ? await groupWorkspaceHistory(entries) : entries,
    };
  });

  messageHub.onRequest('workspace.add', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const workspacePath = await validateWorkspaceDirectory(path);
    await workspaceHistoryRepo.upsertAsync(workspacePath);

    if (mcpImportService) {
      try {
        const result = await mcpImportService.refreshAllForPath(workspacePath);
        if (internalEventBus && (result.added > 0 || result.updated > 0 || result.removed > 0)) {
          internalEventBus.publishAsync('mcp.registry.changed', { sessionId: 'global' });
        }
      } catch (err) {
        log.warn(`[workspace.add] MCP import scan failed for ${workspacePath}:`, err);
      }
    }

    return {
      entry: workspaceHistoryRepo.entries().find((entry) => entry.path === workspacePath)!,
    };
  });

  messageHub.onRequest('workspace.remove', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const success = await workspaceHistoryRepo.removeAsync(path);
    return { success };
  });
}
