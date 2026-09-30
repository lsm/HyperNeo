import type { CapabilityContribution } from './contribution.ts';
import {
  AGENT_MEMORY_MCP_SERVER_NAME,
  DB_QUERY_MCP_SERVER_NAME,
  OPERATIONS_MCP_SERVER_NAME,
} from '../mcp/built-in-servers.ts';

export type CapabilityBriefingKind = 'authored' | 'self-describing';

export interface CapabilityUnit {
  readonly serverName: string;
  readonly kind: CapabilityBriefingKind;
  readonly summary: string;
}

export const CAPABILITY_UNITS: readonly CapabilityUnit[] = [
  {
    serverName: OPERATIONS_MCP_SERVER_NAME,
    kind: 'authored',
    summary:
      'The operation catalog door: operations.list/describe and invocation for this session.',
  },
  {
    serverName: AGENT_MEMORY_MCP_SERVER_NAME,
    kind: 'authored',
    summary: "The Space agent's durable memory: notes it can recall across sessions.",
  },
  {
    serverName: DB_QUERY_MCP_SERVER_NAME,
    kind: 'authored',
    summary: 'Read-only SQL over the daemon database, scoped to the Space.',
  },
];

const UNITS_BY_SERVER: ReadonlyMap<string, CapabilityUnit> = new Map(
  CAPABILITY_UNITS.map((unit) => [unit.serverName, unit])
);

export function findCapabilityUnit(serverName: string): CapabilityUnit | undefined {
  return UNITS_BY_SERVER.get(serverName);
}

export type CapabilityCoverageIssue =
  | { readonly kind: 'undeclared'; readonly serverName: string }
  | {
      readonly kind: 'briefing_mismatch';
      readonly serverName: string;
      readonly declared: CapabilityBriefingKind;
      readonly actual: CapabilityBriefingKind;
    }
  | { readonly kind: 'empty_briefing'; readonly serverName: string };

export function checkCapabilityCoverage(
  contributions: readonly CapabilityContribution[]
): readonly CapabilityCoverageIssue[] {
  const issues: CapabilityCoverageIssue[] = [];
  for (const contribution of contributions) {
    const serverName = contribution.server.name;
    const unit = findCapabilityUnit(serverName);
    if (!unit) {
      issues.push({ kind: 'undeclared', serverName });
      continue;
    }
    if (unit.kind !== contribution.kind) {
      issues.push({
        kind: 'briefing_mismatch',
        serverName,
        declared: unit.kind,
        actual: contribution.kind,
      });
      continue;
    }
    if (contribution.kind === 'authored' && contribution.briefing.trim().length === 0) {
      issues.push({ kind: 'empty_briefing', serverName });
    }
  }
  return issues;
}

export function describeCapabilityCoverageIssue(issue: CapabilityCoverageIssue): string {
  switch (issue.kind) {
    case 'undeclared':
      return `capability "${issue.serverName}" has no declared unit; add it to CAPABILITY_UNITS`;
    case 'briefing_mismatch':
      return `capability "${issue.serverName}" is declared ${issue.declared} but contributed ${issue.actual}`;
    case 'empty_briefing':
      return `capability "${issue.serverName}" is authored but contributed an empty briefing`;
  }
}
