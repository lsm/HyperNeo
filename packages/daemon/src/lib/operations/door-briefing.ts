import { SPACE_OPERATIONS_DOOR } from '@hyperneo/prompts';
import type {
  AttachedMcpServerConfig,
  AuthoredCapabilityContribution,
} from '../briefings/contribution.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { isOperationListed } from './discovery.ts';
import type { OperationCaller, OperationRegistry } from './registry.ts';

const DISCOVERY_OPERATION_NAMES = new Set(['operations.list', 'operations.describe']);

function operationFamily(name: string): string {
  const dotIndex = name.indexOf('.');
  return dotIndex === -1 ? name : name.slice(0, dotIndex);
}

export function describeResolvedOperations(
  registry: OperationRegistry,
  caller: OperationCaller = { source: 'mcp' }
): string {
  const names = registry.entries
    .filter((entry) => isOperationListed(entry, caller))
    .map((entry) => entry.name)
    .filter((name) => !DISCOVERY_OPERATION_NAMES.has(name));
  if (names.length === 0) return '';
  const families = [...new Set(names.map(operationFamily))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const operationWord = names.length === 1 ? 'operation' : 'operations';
  const areaWord = families.length === 1 ? 'area' : 'areas';
  return `operations.list shows this session ${names.length} ${operationWord} across ${families.length} ${areaWord}: ${families.join(', ')}.`;
}

export function operationsCapabilityContribution(
  config: AttachedMcpServerConfig,
  registry?: OperationRegistry,
  caller?: OperationCaller
): AuthoredCapabilityContribution {
  const listing = registry ? describeResolvedOperations(registry, caller) : '';
  return {
    kind: 'authored',
    server: { name: OPERATIONS_MCP_SERVER_NAME, config },
    briefing: listing ? `${SPACE_OPERATIONS_DOOR}\n\n${listing}` : SPACE_OPERATIONS_DOOR,
  };
}
