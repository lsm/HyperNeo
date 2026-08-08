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

import { POST_APPROVAL_TASK_AGENT_TARGET } from '../workflows/post-approval-validator';

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

// ---------------------------------------------------------------------------
// Designated-merger recognition (shared by the query-time policy + rehydrate)
// ---------------------------------------------------------------------------

/**
 * Minimal task shape carrying the designated-merger identity fields. Accepts
 * null/undefined for both so callers can pass a possibly-absent task directly.
 */
export interface DesignatedMergerTask {
  readonly postApprovalSessionId?: string | null;
  readonly postApprovalRequiresMerge?: boolean | null;
}

/**
 * Is `task`'s designated post-approval merger session exactly `sessionId`, with
 * the persisted `postApprovalRequiresMerge` flag explicitly TRUE?
 *
 * Shared by the query-time policy (`resolveSpaceMcpSessionPolicy`) and the
 * restart path (`rehydrateSubSession`). The flag is checked `=== true` so that
 * NULL (legacy rows predating migration 179) and FALSE (an explicit non-merge
 * route) both read as "not the merger" here; rehydrate separately lazy-derives
 * NULL rows via {@link derivePostApprovalRequiresMerge} so a legacy in-flight
 * merger is still recognised.
 *
 * The router/spawner stamp `postApprovalSessionId` for EVERY dispatched route
 * (not just merges), so identity alone is insufficient — the flag is what
 * distinguishes a genuine merge route (#879 P1-2).
 */
export function isDesignatedMergerSession(
  task: DesignatedMergerTask | null | undefined,
  sessionId: string
): boolean {
  return (
    !!task && task.postApprovalSessionId === sessionId && task.postApprovalRequiresMerge === true
  );
}

/**
 * Structural workflow shape carrying the post-approval route templates this
 * helper inspects. `targetAgent` is required to mirror the router's
 * dispatchability filter. Keeps the helper decoupled from `SpaceWorkflow`.
 */
export interface PostApprovalRouteSource {
  readonly nodes?: ReadonlyArray<{
    postApproval?: { targetAgent?: string | null; instructions?: string } | null;
  }>;
  readonly postApproval?: { targetAgent?: string | null; instructions?: string } | null;
}

/**
 * For a task whose `postApprovalRequiresMerge` flag is NULL (a legacy row
 * dispatched before migration 179 added the column), derive whether its
 * post-approval route requires the deterministic merge gate from the workflow's
 * route instruction templates — the same {@link inferRequiredMcpToolsFromProcedure}
 * the spawner applies to the kickoff at dispatch.
 *
 * Mirrors `PostApprovalRouter.route()`'s selection EXACTLY so a legacy NULL row
 * is classified the way its dispatch would have been: collect routes the way
 * `collectPostApprovalRoutes` does (node-level routes suppress the legacy
 * workflow-level fallback), drop non-dispatchable ones (no `targetAgent`, or the
 * legacy `'task-agent'` target), and inspect ONLY the first dispatchable route
 * — the router dispatches at most one. Without this precision a custom workflow
 * whose first route is non-merge but a later route mentions `merge_pr` would be
 * over-provisioned (and, since `loadAuthorizedTask` authorises on session
 * identity + approved status, merge-authorized) — the same class of bug as the
 * blanket backfill this replaces (#879 round-3 / 3740839498).
 */
export function derivePostApprovalRequiresMerge(workflow: PostApprovalRouteSource | null): boolean {
  if (!workflow) return false;
  // collectPostApprovalRoutes: node routes suppress the legacy workflow-level route.
  const nodeRoutes = (workflow.nodes ?? [])
    .map((n) => n.postApproval)
    .filter((r): r is { targetAgent?: string | null; instructions?: string } => !!r);
  const candidates =
    nodeRoutes.length > 0 ? nodeRoutes : workflow.postApproval ? [workflow.postApproval] : [];
  // The router's dispatch filter + first-dispatchable selection: skip routes
  // with no targetAgent or the legacy 'task-agent' target, then take the FIRST.
  for (const route of candidates) {
    if (!route.targetAgent) continue;
    if (route.targetAgent === POST_APPROVAL_TASK_AGENT_TARGET) continue;
    return inferRequiredMcpToolsFromProcedure(route.instructions ?? '').includes(MERGE_PR_TOOL);
  }
  return false;
}
