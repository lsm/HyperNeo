/**
 * Long-term SpaceAgent session config-refresh helpers.
 *
 * Extracted as pure functions so the refresh detection + desired-config
 * derivation have direct unit coverage, mirroring the buildPostApprovalInit
 * pattern. ensureLongTermAgentSession calls these when an existing session is
 * reused so that upgraded Spaces pick up the current permissive tool policy
 * without needing to delete and recreate the session.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Session, SpaceAgent } from '@neokai/shared';
import { resolveCustomAgentPrompt } from '../agents/custom-agent';
import { applyReviewerContractMigrationOverride } from '../agents/reviewer-contract-migration';
import { deriveWorkerDisallowedTools } from '../agents/tool-policy';
import { sanitizeLongTermAgentKey } from './space-runtime-service';

/**
 * Build the desired tool-policy config slice for a long-term SpaceAgent
 * session: cleared sdkToolsPreset/allowedTools, derived disallowedTools
 * (respecting the Reviewer read-only preset override), matching
 * agent/agents entries when the deny list is non-empty, and a refreshed
 * systemPrompt.append carrying the migrated Reviewer contract when applicable.
 *
 * The systemPrompt slice is included because QueryOptionsBuilder ships
 * `config.systemPrompt` alongside `agent`/`agents` on every turn. Without
 * refreshing it, a stale Reviewer session keeps the old shell-based
 * procedure in the top-level system prompt even after the agents entry is
 * updated, so the model still tries `gh pr diff` / `gh pr review` while
 * Bash is denied.
 */
export function buildLongTermAgentDesiredConfig(agent: SpaceAgent): {
  sdkToolsPreset: undefined;
  allowedTools: undefined;
  disallowedTools: string[] | undefined;
  agent: string | undefined;
  agents: Record<string, AgentDefinition> | undefined;
  systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string };
} {
  const customDisallowedTools = deriveWorkerDisallowedTools(agent.tools, {
    templateName: agent.templateName,
  });
  const resolvedPrompt = applyReviewerContractMigrationOverride(
    resolveCustomAgentPrompt(agent, {
      resolutionContext: { agentId: agent.id, agentName: agent.name },
    }).value,
    agent.templateName
  );
  const systemPrompt = {
    type: 'preset' as const,
    preset: 'claude_code' as const,
    append: resolvedPrompt,
  };
  if (customDisallowedTools.length === 0) {
    return {
      sdkToolsPreset: undefined,
      allowedTools: undefined,
      disallowedTools: undefined,
      agent: undefined,
      agents: undefined,
      systemPrompt,
    };
  }
  const agentKey = sanitizeLongTermAgentKey(agent.name);
  return {
    sdkToolsPreset: undefined,
    allowedTools: undefined,
    disallowedTools: customDisallowedTools,
    agent: agentKey,
    agents: {
      [agentKey]: {
        description: agent.description ?? `Space agent: ${agent.name}`,
        disallowedTools: customDisallowedTools,
        model: 'inherit',
        prompt: resolvedPrompt,
      } satisfies AgentDefinition,
    },
    systemPrompt,
  };
}

/**
 * Decide whether a long-term SpaceAgent session's persisted config differs
 * from the desired tool-policy config slice and therefore needs a refresh.
 *
 * Detection covers:
 * - stale `sdkToolsPreset` (pre-migration sessions set this from the old
 *   exhaustive-allowlist policy)
 * - stale `allowedTools`
 * - `disallowedTools` mismatch (deep equality via JSON.stringify)
 * - `agent` mismatch
 * - `agents` mismatch (deep equality via JSON.stringify)
 * - `systemPrompt.append` mismatch (catches stale Reviewer contract overrides)
 */
export function longTermAgentSessionNeedsRefresh(
  currentConfig: Pick<
    Session['config'],
    'sdkToolsPreset' | 'allowedTools' | 'disallowedTools' | 'agent' | 'agents' | 'systemPrompt'
  >,
  desired: ReturnType<typeof buildLongTermAgentDesiredConfig>
): boolean {
  if (currentConfig.sdkToolsPreset !== undefined) return true;
  if (currentConfig.allowedTools !== undefined) return true;
  if (
    JSON.stringify(currentConfig.disallowedTools ?? []) !==
    JSON.stringify(desired.disallowedTools ?? [])
  ) {
    return true;
  }
  if (currentConfig.agent !== desired.agent) return true;
  if (JSON.stringify(currentConfig.agents ?? {}) !== JSON.stringify(desired.agents ?? {})) {
    return true;
  }
  const currentAppend =
    currentConfig.systemPrompt && typeof currentConfig.systemPrompt === 'object'
      ? (currentConfig.systemPrompt as { append?: unknown }).append
      : undefined;
  if (JSON.stringify(currentAppend ?? '') !== JSON.stringify(desired.systemPrompt.append)) {
    return true;
  }
  return false;
}
