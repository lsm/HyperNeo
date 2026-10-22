import type { Session, SessionConfig } from '@hyperneo/shared';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import type { NeoPackBrief } from './pack-contract.ts';
import { neoPrompt } from './prompt.ts';

export function neoReadSandbox() {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    enableWeakerNetworkIsolation: true,
    network: { allowedDomains: ['*'] },
  };
}

export function neoReadTools() {
  const tools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'];
  return {
    sdkToolsPreset: tools,
    allowedTools: [...tools, `mcp__${OPERATIONS_MCP_SERVER_NAME}__invoke`],
    permissionMode: 'dontAsk' as const,
    coordinatorMode: false,
    settingSources: [],
    agent: undefined,
    agents: undefined,
    sandbox: neoReadSandbox(),
  };
}

export function neoPromptTools(packs: readonly NeoPackBrief[]) {
  return { systemPrompt: neoPrompt(packs), ...neoReadTools() };
}

export function planNeoSessionConfig(
  session: Session | null,
  packs: readonly NeoPackBrief[]
): SessionConfig | null {
  if (!session?.config) return null;
  const config = session.config;
  const defaults = neoPromptTools(packs);
  const current = { ...config, ...defaults };
  return JSON.stringify(config) === JSON.stringify(current) ? null : current;
}
