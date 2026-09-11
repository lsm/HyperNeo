import { spaceStore } from '../../lib/space-store';
import { requestAgentFromTemplate } from './agent-create-request';
import { SpaceAgentsPage } from './SpaceAgentsPage';
import { SpaceTemplatesPanel } from './SpaceTemplatesPanel';

export function SpaceAgentsView({
  spaceId,
  selectedHandle,
}: {
  spaceId: string;
  selectedHandle?: string | null;
}) {
  return (
    <div class="h-full overflow-y-auto scrollbar-dark">
      <div class="mx-auto max-w-6xl space-y-7 px-4 py-4 sm:px-8 sm:py-6">
        <SpaceTemplatesPanel
          spaceId={spaceId}
          templates={spaceStore.agentTemplates.value}
          userTemplateKeys={spaceStore.userTemplateKeys.value}
          onUseTemplate={(template) => requestAgentFromTemplate(spaceId, template.key)}
        />
        <SpaceAgentsPage spaceId={spaceId} selectedHandle={selectedHandle} />
      </div>
    </div>
  );
}
