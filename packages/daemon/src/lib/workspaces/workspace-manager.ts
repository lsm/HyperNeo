import type { SpaceWorkspaceRecord } from '../../storage/repositories/space-workspace-repository.ts';
import { nodeWorkspaceValidationIo } from './validation-pipeline.ts';
import {
  runRegisterWorkspace,
  runRemoveWorkspace,
  runUpdateWorkspaceLabel,
} from './workspace-mutation-pipelines.ts';
import type { SpaceWorkspaceManagerDeps } from './workspace-registry.ts';
import {
  runListWorkspaces,
  runResolveRegisteredWorkspace,
  runResolveWorkspaceSelection,
  runValidateDefaultTaskWorkspace,
} from './workspace-resolution-pipelines.ts';

export { buildRegistrySnapshot } from './workspace-registry.ts';
export {
  WorkspaceRegistrationError,
  WorkspaceRemovalBlockedError,
} from './workspace-registry.ts';
export type {
  SpaceWorkspaceManagerDeps,
  WorkspaceGoalReferences,
  WorkspaceRegistryReader,
  WorkspaceSessionReferences,
  WorkspaceStore,
  WorkspaceTaskReferences,
} from './workspace-registry.ts';

export class SpaceWorkspaceManager {
  constructor(private readonly deps: SpaceWorkspaceManagerDeps) {}

  async registerWorkspace(
    spaceId: string,
    rawPath: string,
    label?: string
  ): Promise<SpaceWorkspaceRecord> {
    const result = await runRegisterWorkspace({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      transaction: this.deps.transaction,
      spaceId,
      rawPath,
      label,
    });
    if (result.error) throw result.error;
    if (!result.record) throw new Error('workspace registration produced no record');
    return result.record;
  }

  removeWorkspace(spaceId: string, workspaceId: string): boolean {
    const result = runRemoveWorkspace({
      workspaces: this.deps.workspaces,
      sessionReferences: this.deps.sessionReferences,
      taskReferences: this.deps.taskReferences,
      goalReferences: this.deps.goalReferences,
      spaceId,
      workspaceId,
      removed: false,
    });
    if (result.blocked) throw result.blocked;
    return result.removed;
  }

  listWorkspaces(spaceId: string): SpaceWorkspaceRecord[] {
    const result = runListWorkspaces({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      spaceId,
    });
    if (result.error) throw result.error;
    return result.rows ?? [];
  }

  async resolveRegisteredWorkspacePath(spaceId: string, rawPath: string): Promise<string> {
    const result = await runResolveRegisteredWorkspace({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      spaceId,
      rawPath,
    });
    if (result.error) throw result.error;
    if (!result.registeredPath) {
      throw new Error(`Workspace path is not registered to space: ${rawPath}`);
    }
    return result.registeredPath;
  }

  updateWorkspaceLabel(spaceId: string, workspaceId: string, label: string): boolean {
    const result = runUpdateWorkspaceLabel({
      workspaces: this.deps.workspaces,
      spaceId,
      workspaceId,
      label,
      updated: false,
    });
    return result.updated;
  }

  async resolveWorkspaceSelection(spaceId: string, selection: string): Promise<string> {
    const result = await runResolveWorkspaceSelection({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      spaceId,
      selection,
    });
    if (result.error) throw result.error;
    if (!result.resolvedPath) {
      throw new Error(`Unknown workspace: ${selection}`);
    }
    return result.resolvedPath;
  }

  async validateDefaultTaskWorkspace(spaceId: string): Promise<string | null> {
    const result = await runValidateDefaultTaskWorkspace({
      spaces: this.deps.spaces,
      workspaces: this.deps.workspaces,
      io: this.deps.io ?? nodeWorkspaceValidationIo,
      spaceId,
    });
    return result.blockedMessage ?? null;
  }
}
