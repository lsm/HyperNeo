import { SPACE_DB_QUERY_BRIEFING } from '@hyperneo/prompts';
import type {
  AttachedMcpServerConfig,
  AuthoredCapabilityContribution,
} from '../briefings/contribution.ts';
import { DB_QUERY_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';

export function dbQueryCapabilityContribution(
  config: AttachedMcpServerConfig
): AuthoredCapabilityContribution {
  return {
    kind: 'authored',
    server: { name: DB_QUERY_MCP_SERVER_NAME, config },
    briefing: SPACE_DB_QUERY_BRIEFING,
  };
}
