import { SPACE_OPERATIONS_DOOR } from '@hyperneo/prompts';
import type {
  AttachedMcpServerConfig,
  AuthoredCapabilityContribution,
} from '../briefings/contribution.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import type { OperationRegistry } from './registry.ts';

const DISCOVERY_OPERATION_NAMES = new Set(['operations.list', 'operations.describe']);

function operationFamily(name: string): string {
  const dotIndex = name.indexOf('.');
  return dotIndex === -1 ? name : name.slice(0, dotIndex);
}

export function describeResolvedOperations(registry: OperationRegistry): string {
  const names = registry.entries
    .map((entry) => entry.name)
    .filter((name) => !DISCOVERY_OPERATION_NAMES.has(name));
  if (names.length === 0) return '';
  const families = [...new Set(names.map(operationFamily))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const operationWord = names.length === 1 ? 'operation' : 'operations';
  const areaWord = families.length === 1 ? 'area' : 'areas';
  return `This session's registry currently resolves ${names.length} ${operationWord} across ${families.length} ${areaWord}: ${families.join(', ')}.`;
}

export function operationsCapabilityContribution(
  config: AttachedMcpServerConfig,
  registry?: OperationRegistry
): AuthoredCapabilityContribution {
  const listing = registry ? describeResolvedOperations(registry) : '';
  return {
    kind: 'authored',
    server: { name: OPERATIONS_MCP_SERVER_NAME, config },
    briefing: listing ? `${SPACE_OPERATIONS_DOOR}\n\n${listing}` : SPACE_OPERATIONS_DOOR,
  };
}
