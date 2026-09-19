import { SPACE_AGENT_MEMORY_BRIEFING } from '@hyperneo/prompts';
import type {
  AttachedMcpServerConfig,
  AuthoredCapabilityContribution,
} from '../../briefings/contribution.ts';
import { AGENT_MEMORY_MCP_SERVER_NAME } from '../../mcp/built-in-servers.ts';

export function agentMemoryCapabilityContribution(
  config: AttachedMcpServerConfig
): AuthoredCapabilityContribution {
  return {
    kind: 'authored',
    server: { name: AGENT_MEMORY_MCP_SERVER_NAME, config },
    briefing: SPACE_AGENT_MEMORY_BRIEFING,
  };
}
