import type { UpdateSpaceWorkflowParams } from '@hyperneo/shared';

export function buildWorkflowIdentityPatch(params: UpdateSpaceWorkflowParams): {
  fields: string[];
  values: (string | number | null)[];
} {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (params.name !== undefined) {
    fields.push('name = ?');
    values.push(params.name.trim());
  }
  if (params.description !== undefined) {
    fields.push('description = ?');
    values.push(params.description ?? '');
  }
  if (params.startNodeId !== undefined) {
    fields.push('start_node_id = ?');
    values.push(params.startNodeId ?? null);
  }
  if (params.endNodeId !== undefined) {
    fields.push('end_node_id = ?');
    values.push(params.endNodeId ?? null);
  }
  if (params.tags !== undefined) {
    fields.push('tags = ?');
    values.push(JSON.stringify(params.tags ?? []));
  }
  return { fields, values };
}
