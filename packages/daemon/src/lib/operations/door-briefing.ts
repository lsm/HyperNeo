import { SPACE_OPERATIONS_DOOR } from '@hyperneo/prompts';
import type { McpServerConfig } from '@hyperneo/shared';
import type { CapabilityContribution } from '../briefings/contribution.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';

export function operationsCapabilityContribution(config: McpServerConfig): CapabilityContribution {
  return {
    server: { name: OPERATIONS_MCP_SERVER_NAME, config },
    briefing: SPACE_OPERATIONS_DOOR,
  };
}
