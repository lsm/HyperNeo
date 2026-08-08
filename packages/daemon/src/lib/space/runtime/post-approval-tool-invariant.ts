/**
 * Post-approval provisioning tool invariant (task #879).
 *
 * A workflow slot whose effective prompt/procedure requires a tool must not
 * start unless that tool is in the session's effective SDK tool surface. The
 * concrete case is the PR Merger, whose procedure mandates the deterministic
 * `merge_pr` MCP gate — if `mcp__space-agent-tools__merge_pr` is absent from the
 * provisioned session, the merger cannot merge through the gate and falls back
 * to forbidden raw paths (the #870 failure). This module computes the required
 * tools from the procedure and checks them against a session/init surface,
 * failing clearly before the merger's first turn rather than allowing the
 * prompt/tool drift to surface mid-run.
 *
 * ## SDK availability semantics (verified against @anthropic-ai/claude-agent-sdk)
 *
 * For a fully-qualified MCP tool `mcp__<server>__<tool>`:
 *   - `Options.tools` governs built-in tools only — it does NOT filter MCP tools;
 *   - `Options.allowedTools` only auto-approves (permission); it does NOT restrict
 *     availability;
 *   - `Options.disallowedTools` is the only list that removes MCP tools, via the
 *     server-level specs `mcp__*`, `mcp__<server>`, `mcp__<server>__*`, or an
 *     exact `mcp__<server>__<tool>`.
 *
 * A tool is therefore available iff its MCP server is in the effective MCP map
 * and it is not matched by a `disallowedTools` entry. `space-agent-tools`
 * unconditionally registers `merge_pr`, so server presence ⟹ tool presence.
 */

/** The fully-qualified name of the deterministic post-approval merge gate. */
export const MERGE_PR_TOOL = 'mcp__space-agent-tools__merge_pr';

/** Subset of an init / session config sufficient to evaluate tool availability. */
export interface McpToolSurface {
  /** Runtime MCP server map (`init.mcpServers` / `session.config.mcpServers`). */
  readonly mcpServers?: Record<string, unknown> | null;
  /** SDKConfig disallowedTools. */
  readonly disallowedTools?: readonly string[] | null;
}

/**
 * Parse a fully-qualified MCP tool name `mcp__<server>__<tool>` into its server
 * and tool segments. Returns `null` for anything that is not an MCP tool name.
 *
 * MCP server names use hyphens (e.g. `space-agent-tools`, `node-agent`), never
 * the double-underscore separator, so splitting on `__` cleanly yields
 * `['mcp', <server>, ...<tool segments>]`. Any `__` inside the tool name is
 * preserved by re-joining the trailing segments.
 */
export function parseMcpToolName(qualified: string): { server: string; tool: string } | null {
  const parts = qualified.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  return { server: parts[1]!, tool: parts.slice(2).join('__') };
}

/**
 * Does a `disallowedTools` entry remove this MCP tool? Matches the SDK's
 * server-level specs: exact `mcp__<server>__<tool>`, `mcp__*` (all MCP tools),
 * `mcp__<server>` (whole server), and `mcp__<server>__*` (server wildcard).
 */
export function isMcpToolDisallowed(qualified: string, disallowed: readonly string[]): boolean {
  if (disallowed.length === 0) return false;
  if (disallowed.includes(qualified)) return true;
  const parsed = parseMcpToolName(qualified);
  if (!parsed) return false;
  const serverSpec = `mcp__${parsed.server}`;
  const serverWildcard = `${serverSpec}__*`;
  return (
    disallowed.includes('mcp__*') ||
    disallowed.includes(serverSpec) ||
    disallowed.includes(serverWildcard)
  );
}

/**
 * Infer the MCP tools a post-approval procedure REQUIRES from its text. A
 * procedure that references the deterministic `merge_pr` gate must be able to
 * call it, so it requires {@link MERGE_PR_TOOL}. Conservative (fail-closed):
 * naming the tool obligates the surface to provide it.
 *
 * Detection is text-based so it covers every space — including existing spaces
 * whose workflow routes predate any declarative `requiredTools` field — and
 * matches the task wording ("a slot whose effective prompt/procedure requires
 * merge_pr"). `\bmerge_pr\b` matches the tool call form in the built-in merge
 * template (`merge_pr(pr_url=…)`) without matching prose like "re-merge".
 */
export function inferRequiredMcpToolsFromProcedure(text: string): string[] {
  const required: string[] = [];
  if (/\bmerge_pr\b/.test(text)) required.push(MERGE_PR_TOOL);
  return required;
}

/**
 * Return the required tools NOT satisfied by `surface`: those whose MCP server
 * is absent from the effective map, or which a `disallowedTools` entry removes.
 * An empty result means every required tool is available.
 */
export function findMissingRequiredMcpTools(
  surface: McpToolSurface,
  required: readonly string[]
): string[] {
  if (required.length === 0) return [];
  const servers = new Set(Object.keys(surface.mcpServers ?? {}));
  const disallowed = surface.disallowedTools ?? [];
  const missing: string[] = [];
  for (const qualified of required) {
    const parsed = parseMcpToolName(qualified);
    const server = parsed?.server;
    if (!server || !servers.has(server) || isMcpToolDisallowed(qualified, disallowed)) {
      missing.push(qualified);
    }
  }
  return missing;
}

/**
 * Provisioning invariant: assert every required tool is available on `surface`,
 * throwing a clear, actionable error otherwise. Called before the post-approval
 * kickoff is delivered so a misconfigured (tool-missing) merger fails at spawn
 * time instead of running a degraded turn.
 */
export function assertRequiredMcpToolsAvailable(
  surface: McpToolSurface,
  required: readonly string[],
  context: { sessionId: string; agentName: string; taskId: string }
): void {
  const missing = findMissingRequiredMcpTools(surface, required);
  if (missing.length === 0) return;
  throw new Error(
    `spawnPostApprovalSubSession: the post-approval procedure for agent "${context.agentName}" ` +
      `(task ${context.taskId}) requires MCP tool(s) [${missing.join(', ')}], but they are not ` +
      `in session ${context.sessionId}'s effective tool surface — the providing MCP server is ` +
      `absent or the tool is disallowed. Refusing to start a post-approval turn without the ` +
      `mandated tool (prompt/tool drift). Attach the missing MCP server or relax disallowedTools.`
  );
}
