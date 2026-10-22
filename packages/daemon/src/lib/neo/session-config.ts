import type { Session, SessionConfig } from '@hyperneo/shared';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import type { NeoPackBrief } from './pack-contract.ts';
import { neoPrompt } from './prompt.ts';

export function neoPromptTools(packs: readonly NeoPackBrief[]) {
  const tools = [
    'Read',
    'Write',
    'Edit',
    'NotebookEdit',
    'Grep',
    'Glob',
    'WebSearch',
    'WebFetch',
    'Bash',
  ];
  return {
    systemPrompt: neoPrompt(packs),
    sdkToolsPreset: tools,
    allowedTools: [`mcp__${OPERATIONS_MCP_SERVER_NAME}__invoke`],
  };
}

export function planNeoSessionConfig(
  session: Session | null,
  packs: readonly NeoPackBrief[]
): SessionConfig | null {
  if (!session?.config) return null;
  const config = session.config;
  const defaults = neoPromptTools(packs);
  const current = {
    ...defaults,
    allowedTools: [...new Set([...(config.allowedTools ?? []), ...defaults.allowedTools])],
  };
  return config.systemPrompt === current.systemPrompt &&
    JSON.stringify(config.sdkToolsPreset) === JSON.stringify(current.sdkToolsPreset) &&
    JSON.stringify(config.allowedTools) === JSON.stringify(current.allowedTools)
    ? null
    : { ...config, ...current };
}
