import type { UpdateSpaceWorkflowParams } from '@hyperneo/shared';

export function buildWorkflowOptionsPatch(params: UpdateSpaceWorkflowParams): {
  fields: string[];
  values: (string | number | null)[];
} {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (params.channels !== undefined) {
    fields.push('channels = ?');
    values.push(
      params.channels && params.channels.length > 0 ? JSON.stringify(params.channels) : null
    );
  }

  if (params.hooks !== undefined) {
    fields.push('hooks = ?');
    values.push(params.hooks && params.hooks.length > 0 ? JSON.stringify(params.hooks) : null);
  }

  if (params.layout !== undefined) {
    fields.push('layout = ?');
    values.push(params.layout ? JSON.stringify(params.layout) : null);
  }

  if (params.templateName !== undefined) {
    fields.push('template_name = ?');
    values.push(params.templateName ?? null);
  }
  if (params.templateHash !== undefined) {
    fields.push('template_hash = ?');
    values.push(params.templateHash ?? null);
  }
  if (params.instructions !== undefined) {
    fields.push('instructions = ?');
    values.push(params.instructions ?? null);
  }
  if (params.completionAutonomyLevel !== undefined) {
    fields.push('completion_autonomy_level = ?');
    values.push(params.completionAutonomyLevel);
  }

  if (params.postApproval !== undefined) {
    fields.push('post_approval = ?');
    values.push(params.postApproval ? JSON.stringify(params.postApproval) : null);
  }
  if (params.disabled !== undefined && params.disabled !== null) {
    fields.push('disabled = ?');
    values.push(params.disabled ? 1 : 0);
  }
  if (params.handle !== undefined) {
    fields.push('handle = ?');
    values.push(params.handle ?? null);
  }

  return { fields, values };
}
