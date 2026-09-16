import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
import { slugify, validateSlug } from '../space/slug.ts';
import { WorkflowValidationError } from './workflow-validation-error.ts';

export function validateName(
  repo: SpaceWorkflowRepository,
  spaceId: string,
  name: string,
  excludeId: string | null
): void {
  if (!name) {
    throw new WorkflowValidationError('Workflow name must not be empty');
  }
  const existing = repo.listWorkflows(spaceId);
  for (const wf of existing) {
    if (wf.name === name && wf.id !== excludeId) {
      throw new WorkflowValidationError(`A workflow named "${name}" already exists in this space`);
    }
  }
}

export function validateHandle(
  repo: SpaceWorkflowRepository,
  spaceId: string,
  handle: string,
  excludeId: string | null
): void {
  if (!handle) {
    throw new WorkflowValidationError('Workflow handle must not be empty');
  }
  const slugError = validateSlug(handle);
  if (slugError) {
    throw new WorkflowValidationError(`Invalid workflow handle: ${slugError}`);
  }
  const existingHandles = repo.getHandlesForSpace(spaceId);
  for (const existing of existingHandles) {
    if (existing === handle) {
      const wf = repo.getWorkflowByHandle(spaceId, handle);
      if (wf && wf.id !== excludeId) {
        throw new WorkflowValidationError(
          `A workflow with handle "${handle}" already exists in this space`
        );
      }
    }
  }
}

export function generateUniqueHandle(
  repo: SpaceWorkflowRepository,
  spaceId: string,
  name: string,
  excludeId?: string
): string {
  const existingHandles = repo.getHandlesForSpace(spaceId);
  const filteredHandles = excludeId
    ? existingHandles.filter((h) => {
        const wf = repo.getWorkflowByHandle(spaceId, h);
        return wf?.id !== excludeId;
      })
    : existingHandles;
  const handle = slugify(name, filteredHandles);
  return ensureValidHandle(handle, filteredHandles);
}

function ensureValidHandle(handle: string, existingHandles: string[]): string {
  const maxLen = 60;
  if (validateSlug(handle) === null) return handle;

  for (let len = maxLen; len > 0; len--) {
    const truncated = handle.slice(0, len);
    const cleaned = truncated.replace(/-+$/, '');
    const fallback = cleaned || 'workflow';
    const candidate = slugify(fallback, existingHandles);
    if (validateSlug(candidate) === null) {
      return candidate;
    }
  }
  return 'workflow';
}
