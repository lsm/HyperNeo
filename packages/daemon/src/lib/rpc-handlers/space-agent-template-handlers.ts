import type {
  CreateSpaceAgentTemplateParams,
  MessageHub,
  UpdateSpaceAgentTemplateParams,
} from '@hyperneo/shared';
import { isReservedAgentHandle } from '../space/agent-handle.ts';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates.ts';
import type { SpaceAgentTemplateManager } from '../space/managers/space-agent-template-manager.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';

const METHOD_PREFIX = 'spaceAgentTemplate';

export interface SpaceAgentTemplateDeps {
  spaceManager: Pick<SpaceManager, 'getSpace'>;
  templateManager?: SpaceAgentTemplateManager;
}

export function setupSpaceAgentTemplateHandlers(
  messageHub: MessageHub,
  deps: SpaceAgentTemplateDeps
): void {
  const method = (name: string): string => `${METHOD_PREFIX}.${name}`;
  const templateManager = deps.templateManager;

  const requireTemplateSpace = async (spaceId: string | undefined): Promise<string> => {
    if (!spaceId) throw new Error('spaceId is required');
    const space = await deps.spaceManager.getSpace(spaceId);
    if (!space) throw new Error(`Space not found: ${spaceId}`);
    return spaceId;
  };

  messageHub.onRequest(method('listBuiltIn'), async (data) => {
    await requireTemplateSpace((data as { spaceId?: string }).spaceId);
    return {
      templates: getLongHorizonAgentTemplates().filter(
        (template) => !isReservedAgentHandle(template.handle)
      ),
    };
  });

  if (!templateManager) return;

  messageHub.onRequest(method('list'), async (data) => {
    const spaceId = await requireTemplateSpace((data as { spaceId?: string }).spaceId);
    return { templates: templateManager.listIn(spaceId) };
  });

  messageHub.onRequest(method('create'), async (data) => {
    const params = data as { spaceId?: string } & CreateSpaceAgentTemplateParams;
    const spaceId = await requireTemplateSpace(params.spaceId);
    if (!params.key) throw new Error('key is required');
    if (!params.handle) throw new Error('handle is required');
    const result = await templateManager.createIn(spaceId, params);
    if (!result.ok) throw new Error(result.error);
    return { template: result.value };
  });

  messageHub.onRequest(method('update'), async (data) => {
    const params = data as { spaceId?: string; key: string } & UpdateSpaceAgentTemplateParams;
    const spaceId = await requireTemplateSpace(params.spaceId);
    if (!params.key) throw new Error('key is required');
    const { key, spaceId: _spaceId, ...updates } = params;
    const result = await templateManager.updateIn(spaceId, key, updates);
    if (!result.ok) throw new Error(result.error);
    return { template: result.value };
  });

  messageHub.onRequest(method('delete'), async (data) => {
    const params = data as { spaceId?: string; key: string; expectedVersion?: number };
    const spaceId = await requireTemplateSpace(params.spaceId);
    if (!params.key) throw new Error('key is required');
    const result = templateManager.deleteIn(spaceId, params.key, params.expectedVersion);
    if (!result.ok) throw new Error(result.error);
    return { success: true };
  });
}
