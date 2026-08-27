import type { SpaceTask, SpaceWorkspace, UpdateSpaceTaskParams } from '@hyperneo/shared';

export function buildMarkDonePayload(task: SpaceTask): UpdateSpaceTaskParams {
  return {
    status: 'done',
    ...(task.status === 'approved'
      ? {
          postApprovalSessionId: null,
          postApprovalStartedAt: null,
          postApprovalBlockedReason: null,
        }
      : {}),
  };
}

export function getWorkspaceLabel(
  workspacePath: string | null | undefined,
  workspaces: SpaceWorkspace[],
  primaryPath?: string | null
): string | null {
  if (!workspacePath) return null;

  const resolvedPrimary = primaryPath ?? workspaces.find((w) => w.isPrimary)?.path;
  if (!resolvedPrimary) return null;
  if (workspacePath === resolvedPrimary) return null;

  const match = workspaces.find((w) => w.path === workspacePath);
  if (match?.label) return match.label;

  return workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath;
}

export function getTaskWorkspaceLabel(
  task: SpaceTask,
  workspaces: SpaceWorkspace[],
  primaryPath?: string | null
): string | null {
  return getWorkspaceLabel(task.workspacePath, workspaces, primaryPath);
}
