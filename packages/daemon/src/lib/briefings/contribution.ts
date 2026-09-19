import type { McpSdkServerConfigWithInstance } from '@hyperneo/shared/sdk';
import type { McpServerConfig } from '@hyperneo/shared/types/sdk-config';

export type AttachedMcpServerConfig = McpServerConfig | McpSdkServerConfigWithInstance;

export interface McpServerAttachment {
  readonly name: string;
  readonly config: AttachedMcpServerConfig;
}

export interface AuthoredCapabilityContribution {
  readonly kind: 'authored';
  readonly server: McpServerAttachment;
  readonly briefing: string;
}

export type CapabilityContribution =
  | AuthoredCapabilityContribution
  | { readonly kind: 'self-describing'; readonly server: McpServerAttachment };

export const SCOPE_FACET_ORDER = ['space', 'role', 'workspace', 'standing_instructions'] as const;

export type ScopeFacet = (typeof SCOPE_FACET_ORDER)[number];

export interface ScopeContribution {
  readonly facet: ScopeFacet;
  readonly briefing: string;
}
