/**
 * Pure logic utilities for ToolsModal.
 *
 * Extracted so both the component and unit tests import the same functions,
 * ensuring tests cover actual component logic rather than re-implementations.
 *
 * NOTE: Legacy per-server disabled-list helpers (`isServerEnabled`,
 * `toggleServer`, `toggleGroupServers`, `computeGroupState`) and the
 * `resolveSettingSources` helper were removed in M5. MCP enablement now flows
 * through the unified `app_mcp_servers` registry + `mcp_enablement` overrides
 * table; setting sources are no longer surfaced in the per-session UI because
 * the SDK is locked to `settingSources: []`.
 */

import type {
  AppMcpServer,
  AppSkill,
  McpEffectiveEnablementSource,
  SessionMcpServerEntry,
} from '@neokai/shared';

/**
 * Compute group-level toggle state for a list of items keyed only by an
 * `enabled` flag.
 *
 * Returns `allEnabled: false` and `someEnabled: false` when the list is empty
 * to avoid vacuous-truth `[].every()` returning `true`. Used by both the
 * Skills and MCP Servers sections to drive the "All on / Mixed / All off"
 * group header in the modal.
 */
export function computeSkillGroupState(items: { enabled: boolean }[]): {
  allEnabled: boolean;
  someEnabled: boolean;
  isIndeterminate: boolean;
} {
  if (items.length === 0) {
    return { allEnabled: false, someEnabled: false, isIndeterminate: false };
  }
  const allEnabled = items.every((s) => s.enabled);
  const someEnabled = items.some((s) => s.enabled);
  return { allEnabled, someEnabled, isIndeterminate: someEnabled && !allEnabled };
}

/**
 * The runtime state of an mcp_server-backed skill with respect to a specific
 * session. Used by the Tools modal to explain *why* a skill the user sees as
 * "enabled" may not actually be injected into the current query.
 *
 *   - `active`           — the backing MCP server is effectively enabled for
 *                          this session and the skill's enablement chain does
 *                          not block it. The SDK will see the tools at the
 *                          next `build()`.
 *   - `skill-disabled`   — the skill itself is off in the app-level registry,
 *                          so the skill bridge skips it regardless of MCP
 *                          overrides.
 *   - `server-off`       — the backing `app_mcp_servers` entry is disabled
 *                          (either by its registry default or by an explicit
 *                          `mcp_enablement` override along this session's
 *                          scope chain). `overrideSource` pinpoints which
 *                          scope owns the decision.
 *   - `server-missing`   — the skill's `appMcpServerId` points at an
 *                          `app_mcp_servers` row that no longer exists.
 *                          Orphaned skill — never reaches any session.
 *   - `unknown`          — we could not determine runtime state (e.g. the
 *                          session-MCP list hasn't loaded yet). Treated as
 *                          "no indicator shown" by callers.
 */
export type McpSkillRuntimeStatus =
  | 'active'
  | 'skill-disabled'
  | 'server-off'
  | 'server-missing'
  | 'unknown';

export interface McpSkillRuntimeState {
  status: McpSkillRuntimeStatus;
  /** The `app_mcp_servers.id` the skill points at, when known. */
  appMcpServerId?: string;
  /**
   * Which level of the scope chain owns the `server-off` decision. Present
   * only when `status === 'server-off'`; omitted for other statuses.
   */
  overrideSource?: SessionMcpServerEntry['source'];
  /** Short label suitable for rendering under the skill name. */
  label: string;
}

/**
 * Compute the runtime state of a single skill relative to a session.
 *
 * For non-`mcp_server` skills (builtin / plugin) we return `status: 'unknown'`
 * because there is no analogous session-scope override path; the component
 * should render no indicator.
 *
 * @param skill            The app-level skill whose runtime state to compute.
 * @param sessionMcpList   The `SessionMcpListResponse.entries` payload for
 *                         the current session. When empty (not yet loaded or
 *                         no registry entries), we return `unknown` even for
 *                         `mcp_server` skills so the UI stays calm.
 * @param sessionMcpLoaded Explicit flag from the caller saying the list has
 *                         been populated at least once. Without this we can't
 *                         distinguish "no entries" (stable) from "not loaded
 *                         yet" (loading).
 */
export function computeMcpSkillRuntimeState(
  skill: AppSkill,
  sessionMcpList: SessionMcpServerEntry[],
  sessionMcpLoaded: boolean
): McpSkillRuntimeState {
  if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') {
    return { status: 'unknown', label: '' };
  }

  const appMcpServerId = skill.config.appMcpServerId;

  if (!sessionMcpLoaded) {
    return { status: 'unknown', appMcpServerId, label: '' };
  }

  // If the skill itself is off, the skill bridge never injects it regardless
  // of the backing server's enablement. Surface that first so users aren't
  // misled by a green "active" indicator when their own checkbox is off.
  if (!skill.enabled) {
    const entry = sessionMcpList.find((e) => e.server.id === appMcpServerId);
    if (!entry) {
      return {
        status: 'server-missing',
        appMcpServerId,
        label: 'No backing MCP server',
      };
    }
    return {
      status: 'skill-disabled',
      appMcpServerId,
      label: 'Skill off — not injected',
    };
  }

  const entry = sessionMcpList.find((e) => e.server.id === appMcpServerId);
  if (!entry) {
    return {
      status: 'server-missing',
      appMcpServerId,
      label: 'No backing MCP server',
    };
  }

  if (!entry.enabled) {
    const where =
      entry.source === 'session'
        ? 'this session'
        : entry.source === 'room'
          ? 'room'
          : entry.source === 'space'
            ? 'space'
            : 'registry';
    return {
      status: 'server-off',
      appMcpServerId,
      overrideSource: entry.source,
      label: `MCP server disabled at ${where}`,
    };
  }

  return {
    status: 'active',
    appMcpServerId,
    label: 'Active in this session',
  };
}

/**
 * Tailwind class pair for the runtime-state indicator (dot + label text).
 *
 * Colour semantics:
 *   - active          → emerald (all good)
 *   - server-off      → amber   (a scope override the user may not have set)
 *   - server-missing  → red     (data-integrity problem)
 *   - skill-disabled  → gray    (the user's own choice)
 *   - unknown         → gray    (no indicator — caller should suppress render)
 *
 * Amber for `server-off` is deliberately aligned with the amber orphan-warning
 * in `AppMcpServersSettings`: both signal "this doesn't do what you think it
 * does", and sharing the colour makes that signal consistent across views.
 */
export interface McpSkillRuntimeClasses {
  dot: string;
  text: string;
}

export function getMcpSkillRuntimeClasses(status: McpSkillRuntimeStatus): McpSkillRuntimeClasses {
  switch (status) {
    case 'active':
      return { dot: 'bg-emerald-400', text: 'text-emerald-500/70' };
    case 'server-off':
      return { dot: 'bg-amber-400', text: 'text-amber-500/70' };
    case 'server-missing':
      return { dot: 'bg-red-400', text: 'text-red-400' };
    case 'skill-disabled':
    case 'unknown':
      return { dot: 'bg-gray-500', text: 'text-gray-500' };
  }
}

/**
 * For each `app_mcp_servers` entry, look up the (single) skill that wraps it.
 * Skills are stored with `sourceType === 'mcp_server'` and
 * `config.appMcpServerId` pointing at an `app_mcp_servers.id`. Returns a map
 * keyed by server ID so the Global Settings MCP Servers page can render "this
 * server is exposed as skill X" in O(1) per row.
 *
 * When multiple skills point at the same server ID (pathological — seed +
 * user clone) we keep the first; the UI shouldn't encourage that topology.
 */
export function computeMcpServerSkillLinkage(skills: AppSkill[]): Map<string, AppSkill> {
  const map = new Map<string, AppSkill>();
  for (const skill of skills) {
    if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') continue;
    const serverId = skill.config.appMcpServerId;
    if (!serverId) continue;
    if (!map.has(serverId)) {
      map.set(serverId, skill);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Unified-view helpers (session Tools modal — task #122)
//
// The session modal renders two unified lists: one for *all* skills (builtin,
// plugin, mcp_server) and one for *all* MCP servers (registry + per-scope
// effective state). Source is shown only as a small badge per row, never as
// a top-level grouping axis. The helpers below compute:
//
//   - the effective enabled-for-this-session flag, given globals + the user's
//     pending toggle state in the modal;
//   - source-badge labels and colour pairs that stay consistent between the
//     two lists.
//
// All toggles in the modal are deferred — `pendingDisabledSkills` /
// `pendingMcpServerOverrides` capture the user's choices until they click
// Save, at which point the modal applies them via `tools.save` +
// `mcp.enablement.setOverride`. These helpers are pure so the same logic is
// exercised by both the component and its unit tests.
// ---------------------------------------------------------------------------

/**
 * Whether a skill is currently enabled for this session, given the registry
 * state plus the modal's local pending changes.
 *
 * The session can only *opt out* of skills — it cannot opt in to a skill that
 * is globally disabled. This matches the daemon-side filter in
 * `QueryOptionsBuilder.getSessionDisabledSkillIds()` and keeps the UI in lockstep
 * with the underlying enablement contract.
 */
export function isSkillEnabledForSession(
  skill: AppSkill,
  pendingDisabledSkills: ReadonlySet<string>
): boolean {
  if (!skill.enabled) return false;
  return !pendingDisabledSkills.has(skill.id);
}

/**
 * Return the set of skill IDs that should land in
 * `ToolsConfig.disabledSkills` after the user clicks Save.
 *
 * We only persist IDs that are still in the registry — this prevents stale
 * disabled-skill entries from accumulating across rename/delete cycles.
 */
export function buildDisabledSkillsList(
  skills: AppSkill[],
  pendingDisabledSkills: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const skill of skills) {
    if (pendingDisabledSkills.has(skill.id)) out.push(skill.id);
  }
  return out;
}

/**
 * Stable visual identity for a skill source. Both the badge label and the
 * Tailwind colour live here so the two lists (skills + MCP servers) stay
 * visually consistent and tests can assert against a single source of truth.
 *
 * Colour rationale:
 *   - builtin    → blue   (shipped with NeoKai)
 *   - plugin     → violet (local plugin directory)
 *   - mcp_server → amber  (matches the AppMcpServersSettings amber accent)
 */
export interface SourceBadgeStyle {
  label: string;
  className: string;
}

export function getSkillSourceBadge(skill: AppSkill): SourceBadgeStyle {
  switch (skill.sourceType) {
    case 'builtin':
      return { label: 'Built-in', className: 'text-blue-400/80 bg-blue-400/10' };
    case 'plugin':
      return { label: 'Plugin', className: 'text-violet-400/80 bg-violet-400/10' };
    case 'mcp_server':
      return { label: 'MCP', className: 'text-amber-400/80 bg-amber-400/10' };
  }
}

/**
 * Effective enablement source ordering for MCP servers — most-specific first.
 * Used to label the source badge and to keep ordering deterministic in tests.
 */
const MCP_SOURCE_LABELS: Record<McpEffectiveEnablementSource, SourceBadgeStyle> = {
  session: { label: 'Session override', className: 'text-sky-400/80 bg-sky-400/10' },
  room: { label: 'Inherited from room', className: 'text-purple-400/80 bg-purple-400/10' },
  space: { label: 'Inherited from space', className: 'text-fuchsia-400/80 bg-fuchsia-400/10' },
  registry: { label: 'Registry default', className: 'text-gray-400/80 bg-gray-400/10' },
};

/**
 * Badge for the *effective enablement decision* — i.e., "where this server's
 * on/off state currently comes from". Independent from the registry-provenance
 * badge below.
 */
export function getMcpServerSourceBadge(source: McpEffectiveEnablementSource): SourceBadgeStyle {
  return MCP_SOURCE_LABELS[source];
}

/**
 * Badge for the *registry provenance* — where the underlying server entry was
 * authored (built-in, user-created, imported from .mcp.json). Useful in the
 * modal's hover tooltip so users can tell a built-in chrome-devtools row apart
 * from one they imported from a project's .mcp.json.
 */
export function getMcpServerProvenanceBadge(server: AppMcpServer): SourceBadgeStyle {
  switch (server.source) {
    case 'builtin':
      return { label: 'Built-in', className: 'text-blue-400/80 bg-blue-400/10' };
    case 'imported':
      return { label: 'Imported', className: 'text-emerald-400/80 bg-emerald-400/10' };
    case 'user':
      return { label: 'User', className: 'text-gray-300/80 bg-gray-400/10' };
  }
}

/**
 * Pending change to a single MCP server's effective enablement.
 *
 *   - `enabled: boolean` — user toggled the checkbox; persist as a session
 *                          override on Save.
 *   - `enabled: null`    — user clicked "Clear override"; delete any session
 *                          override on Save and revert to inheritance.
 *
 * Callers diff this against the latest `SessionMcpServerEntry.enabled` to
 * decide whether the change is still meaningful at Save time.
 */
export type PendingMcpOverride = { enabled: boolean | null };

/**
 * Effective enabled state for the modal checkbox, taking pending changes into
 * account.
 *
 * If the user has a pending toggle, that wins. If they cleared the override,
 * we fall back to whatever the daemon's resolution returned — but if the
 * cleared override was previously a session-scope one, the daemon-side
 * inherited value is what the user will see after Save, so we display that.
 */
export function getMcpServerEffectiveEnabled(
  entry: SessionMcpServerEntry,
  pending: PendingMcpOverride | undefined
): boolean {
  if (pending && pending.enabled !== null) return pending.enabled;
  return entry.enabled;
}
