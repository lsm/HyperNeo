import { SPACE_OPERATIONS_DOOR } from '@hyperneo/prompts';
import type {
  AttachedMcpServerConfig,
  AuthoredCapabilityContribution,
} from '../briefings/contribution.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';

export function operationsCapabilityContribution(
  config: AttachedMcpServerConfig
): AuthoredCapabilityContribution {
  return {
    kind: 'authored',
    server: { name: OPERATIONS_MCP_SERVER_NAME, config },
    briefing: SPACE_OPERATIONS_DOOR,
  };
}
