import type {
  AgentModelPoolEntry,
  SettingSource,
  SpaceAgent,
  SpaceAgentStatus,
  ThinkingLevel,
} from '@hyperneo/shared';
import type { ToolsSelection } from './ToolsEditor';
import { poolFromAgent } from './agent-model-pool';

export interface AgentFormFields {
  status: SpaceAgentStatus;
  autonomy: string;
  modelPool: AgentModelPoolEntry[];
  tools: ToolsSelection;
  settingSources: SettingSource[] | null;
  thinkingLevel: ThinkingLevel | null;
  templateKey: string;
  toolsExplicit: boolean;
}

export function blankAgentForm(): AgentFormFields {
  return {
    status: 'active',
    autonomy: '',
    modelPool: [],
    tools: { tools: [], toolsOverridden: false },
    settingSources: null,
    thinkingLevel: null,
    templateKey: '',
    toolsExplicit: false,
  };
}

export function agentFormFrom(agent: SpaceAgent): AgentFormFields {
  return {
    status: agent.status,
    autonomy: agent.autonomyLevel ? String(agent.autonomyLevel) : '',
    modelPool: poolFromAgent(agent),
    tools: { tools: agent.tools ?? [], toolsOverridden: agent.tools !== null },
    settingSources: agent.settingSources ?? null,
    thinkingLevel: agent.thinkingLevel ?? null,
    templateKey: '',
    toolsExplicit: agent.tools !== null,
  };
}
