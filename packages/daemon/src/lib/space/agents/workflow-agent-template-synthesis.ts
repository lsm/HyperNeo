import type {
  CreateSpaceAgentTemplateParams,
  SettingSource,
  SpaceAgentAutonomyLevel,
  ThinkingLevel,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import { slugify } from '../slug.ts';

export const MIGRATED_WORKFLOW_TEMPLATE_PREFIX = 'migrated.';

export interface WorkflowAgentTemplateSynthesisSource {
  id: string;
  handle: string;
  displayName: string;
  description?: string | null;
  instructions?: string | null;
  autonomyLevel?: SpaceAgentAutonomyLevel | null;
  model?: string | null;
  provider?: string | null;
  thinkingLevel?: ThinkingLevel | null;
  settingSources?: readonly SettingSource[] | null;
  tools?: readonly string[] | null;
  modelPool?: readonly WorkerAgentModelPoolEntry[] | null;
}

export interface OrphanWorkflowAgentTemplateRef {
  agentId: string;
  slotName: string;
}

export function allocateMigratedTemplateKey(
  seed: string,
  agentId: string,
  claimed: ReadonlySet<string>
): string {
  const base = `${MIGRATED_WORKFLOW_TEMPLATE_PREFIX}${slugify(seed)}`;
  if (!claimed.has(base)) return base;
  const suffix = agentId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  const uniquified = suffix ? `${base}.${suffix}` : `${base}.x`;
  if (!claimed.has(uniquified)) return uniquified;
  let attempt = 2;
  while (claimed.has(`${uniquified}.${attempt}`)) attempt += 1;
  return `${uniquified}.${attempt}`;
}

export function synthesizeWorkflowAgentTemplate(
  source: WorkflowAgentTemplateSynthesisSource,
  key: string
): CreateSpaceAgentTemplateParams {
  return {
    key,
    handle: slugify(source.handle || source.displayName || source.id),
    displayName: source.displayName,
    description: source.description ?? '',
    instructions: source.instructions ?? '',
    suggestedAutonomyLevel: source.autonomyLevel ?? 2,
    model: source.model ?? null,
    provider: source.provider ?? null,
    modelPool: copyEntries(source.modelPool),
    thinkingLevel: source.thinkingLevel ?? null,
    settingSources: copyEntries(source.settingSources),
    tools: copyEntries(source.tools),
  };
}

export function synthesizeOrphanWorkflowAgentTemplate(
  ref: OrphanWorkflowAgentTemplateRef,
  key: string
): CreateSpaceAgentTemplateParams {
  const displayName = ref.slotName.trim() || ref.agentId;
  return {
    key,
    handle: slugify(displayName),
    displayName,
    description: '',
    instructions: '',
    suggestedAutonomyLevel: 2,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
  };
}

function copyEntries<T>(entries: readonly T[] | null | undefined): T[] | null {
  return entries && entries.length > 0 ? [...entries] : null;
}
