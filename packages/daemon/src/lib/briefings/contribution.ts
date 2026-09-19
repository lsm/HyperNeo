import type { McpServerConfig } from '@hyperneo/shared/types/sdk-config';

export interface McpServerAttachment {
  readonly name: string;
  readonly config: McpServerConfig;
}

export interface CapabilityContribution {
  readonly server: McpServerAttachment;
  readonly briefing: string;
}

export const SCOPE_FACET_ORDER = ['space', 'role', 'workspace', 'standing_instructions'] as const;

export type ScopeFacet = (typeof SCOPE_FACET_ORDER)[number];

export interface ScopeContribution {
  readonly facet: ScopeFacet;
  readonly briefing: string;
}
