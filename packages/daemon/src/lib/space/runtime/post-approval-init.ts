/**
 * Post-approval session init helpers.
 *
 * Post-approval merge sessions execute privileged workflows (e.g. PR merge via
 * gh/git). They reuse the reviewer slot's prompt provenance but must not
 * inherit the reviewer's read-only tool restrictions or the Reviewer system
 * contract's "do not run Bash/scripts/shell" rule.
 *
 * `buildPostApprovalInit` strips worker-derived `disallowedTools` on the
 * session init and the active agent definition only (not every entry in
 * `init.agents`) and appends a prompt override to the active agent that lifts
 * the read-only rule for this session. Other agent definitions are untouched.
 *
 * Extracted as a pure helper so the behaviour has direct unit coverage
 * independent of `TaskAgentManager.spawnPostApprovalSubSession`'s plumbing.
 */

import type { AgentSessionInit } from '../../../lib/agent/agent-session';

/**
 * Suffix appended to the active agent's prompt in post-approval sessions.
 * Exported so tests can assert presence without hardcoding the prose.
 */
export const POST_APPROVAL_PROMPT_OVERRIDE =
  '\n\n## Post-Approval Override\n' +
  'You are running as the post-approval merge session. The read-only rule above ' +
  'does NOT apply to this session: you are explicitly authorised and required to ' +
  'run `gh pr merge`, `gh pr view`, `gh pr checks`, `git fetch`, `git checkout`, ' +
  'and any other shell commands needed to merge the approved PR and sync the ' +
  'worktree. Use the instructions in the kickoff message as your source of truth.';

/**
 * Strip worker-derived tool restrictions from a post-approval session init and
 * append the read-only-rule override to the active agent's prompt.
 *
 * - Session-level `disallowedTools` is cleared.
 * - Session-level `toolGuards` is cleared (post-approval merge sessions must
 *   be able to run `gh pr merge`; a pre-existing guard like
 *   CODER_NO_MERGE_GUARD on the routed slot would otherwise deny that exact
 *   command while the prompt tells the session to run it).
 * - `init.agents[init.agent].disallowedTools` is cleared.
 * - `init.agents[init.agent].prompt` gets POST_APPROVAL_PROMPT_OVERRIDE appended.
 * - All other agent definitions in `init.agents` are untouched.
 * - No-op when the init has no worker denies, no tool guards, and no active agent prompt.
 */
export function buildPostApprovalInit(init: AgentSessionInit): AgentSessionInit {
  let next: AgentSessionInit = init;

  if (next.disallowedTools && next.disallowedTools.length > 0) {
    next = { ...next, disallowedTools: undefined };
  }

  if (next.toolGuards && next.toolGuards.length > 0) {
    next = { ...next, toolGuards: undefined };
  }

  if (!next.agent || !next.agents) return next;

  const agentKey = next.agent;
  const activeDef = next.agents[agentKey];
  if (!activeDef) return next;

  const basePrompt = typeof activeDef.prompt === 'string' ? activeDef.prompt : '';
  const strippedDef = {
    ...activeDef,
    disallowedTools: undefined,
    prompt: basePrompt + POST_APPROVAL_PROMPT_OVERRIDE,
  };

  return {
    ...next,
    agents: {
      ...next.agents,
      [agentKey]: strippedDef,
    },
  };
}
