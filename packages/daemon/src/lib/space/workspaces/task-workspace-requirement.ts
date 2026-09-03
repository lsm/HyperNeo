import superpipe, { type PipelineAPI } from 'superpipe';

export interface TaskWorkspaceRequirementStores {
  spaces: { getSpace(spaceId: string): { workspacePath: string } | null };
  workspaces: {
    listBySpace(spaceId: string): Array<{ path: string; label: string | null; isPrimary: boolean }>;
  };
}

export interface TaskWorkspaceRequirementCtx extends TaskWorkspaceRequirementStores {
  spaceId: string;
  hasExplicitSelection: boolean;
  choices?: Array<{ path: string; label: string | null; isPrimary: boolean }>;
  error?: Error;
}

function requirementLoadChoices(ctx: TaskWorkspaceRequirementCtx): TaskWorkspaceRequirementCtx {
  const space = ctx.spaces.getSpace(ctx.spaceId);
  if (!space) {
    return { ...ctx, error: new Error(`Space not found: ${ctx.spaceId}`) };
  }
  const choices = ctx.workspaces.listBySpace(ctx.spaceId).map((row) => ({
    path: row.path,
    label: row.label ? row.label : null,
    isPrimary: Boolean(row.isPrimary),
  }));
  if (space.workspacePath && !choices.some((choice) => choice.path === space.workspacePath)) {
    choices.push({ path: space.workspacePath, label: null, isPrimary: true });
  }
  return { ...ctx, choices };
}

function requirementChoiceList(ctx: TaskWorkspaceRequirementCtx): string {
  const entries = ctx.choices!.map((choice) => {
    const label = choice.label ? `"${choice.label}" ` : '';
    const marker = choice.isPrimary ? ' (primary)' : '';
    return `${label}(${choice.path})${marker}`;
  });
  return entries.length > 0 ? entries.join(', ') : '(none)';
}

function requirementDecide(ctx: TaskWorkspaceRequirementCtx): TaskWorkspaceRequirementCtx {
  if (ctx.choices!.length <= 1 || ctx.hasExplicitSelection) {
    return ctx;
  }
  return {
    ...ctx,
    error: new Error(
      `Space ${ctx.spaceId} has multiple registered workspaces; a task workspace is required. ` +
        `Registered workspaces: ${requirementChoiceList(ctx)}. ` +
        `Pass workspace (label or path) when creating or updating the task, pin the goal (update_goal workspace_path), or set the schedule workspace.`
    ),
  };
}

const runTaskWorkspaceRequirement = (
  superpipe({
    hasError: (ctx: TaskWorkspaceRequirementCtx) => ctx.error !== undefined,
  })('task-workspace-requirement') as PipelineAPI
)
  .input(['ctx'])
  .pipe(requirementLoadChoices, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(requirementDecide, 'ctx', 'ctx')
  .endAsync('ctx') as (input: TaskWorkspaceRequirementCtx) => Promise<TaskWorkspaceRequirementCtx>;

export async function requireTaskWorkspaceSelection(
  input: TaskWorkspaceRequirementCtx
): Promise<void> {
  const result = await runTaskWorkspaceRequirement(input);
  if (result.error) throw result.error;
}

export function isExplicitWorkspaceSelection(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim() !== '';
}
