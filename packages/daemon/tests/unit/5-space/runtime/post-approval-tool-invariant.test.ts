/**
 * Unit tests for the post-approval provisioning tool invariant (task #879).
 *
 * The invariant guarantees that a post-approval procedure which requires a tool
 * (the PR Merger's `merge_pr`) cannot start unless that tool is in the
 * provisioned session's effective SDK tool surface. These tests cover the pure
 * detection/evaluation helpers; the spawner integration (eager attach + the
 * assert call on both branches) is covered by
 * `spawn-post-approval-merge-pr-provisioning.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  assertRequiredMcpToolsAvailable,
  derivePostApprovalRequiresMerge,
  findMissingRequiredMcpTools,
  inferRequiredMcpToolsFromProcedure,
  isDesignatedMergerSession,
  isMcpToolDisallowed,
  MERGE_PR_TOOL,
  parseMcpToolName,
} from '../../../../src/lib/space/runtime/post-approval-tool-invariant.ts';

describe('parseMcpToolName', () => {
  test('parses mcp__<server>__<tool> into server + tool', () => {
    expect(parseMcpToolName('mcp__space-agent-tools__merge_pr')).toEqual({
      server: 'space-agent-tools',
      tool: 'merge_pr',
    });
    expect(parseMcpToolName('mcp__node-agent__send_message')).toEqual({
      server: 'node-agent',
      tool: 'send_message',
    });
  });

  test('preserves double-underscore inside the tool segment', () => {
    expect(parseMcpToolName('mcp__srv__some__tool')).toEqual({
      server: 'srv',
      tool: 'some__tool',
    });
  });

  test('returns null for non-MCP tool names', () => {
    expect(parseMcpToolName('Bash')).toBeNull();
    expect(parseMcpToolName('Read')).toBeNull();
    expect(parseMcpToolName('mcp__onlyone')).toBeNull();
    expect(parseMcpToolName('notmcp__a__b')).toBeNull();
    expect(parseMcpToolName('')).toBeNull();
  });
});

describe('isMcpToolDisallowed', () => {
  const tool = MERGE_PR_TOOL; // mcp__space-agent-tools__merge_pr

  test('matches the exact qualified name', () => {
    expect(isMcpToolDisallowed(tool, [tool])).toBe(true);
  });

  test('matches the global mcp__* spec', () => {
    expect(isMcpToolDisallowed(tool, ['mcp__*'])).toBe(true);
  });

  test('matches the server-level mcp__<server> spec', () => {
    expect(isMcpToolDisallowed(tool, ['mcp__space-agent-tools'])).toBe(true);
  });

  test('matches the server wildcard mcp__<server>__*', () => {
    expect(isMcpToolDisallowed(tool, ['mcp__space-agent-tools__*'])).toBe(true);
  });

  test('does not match unrelated disallow entries (built-ins, other servers)', () => {
    expect(
      isMcpToolDisallowed(tool, ['Write', 'Edit', 'mcp__node-agent__*', 'mcp__db-query__run_query'])
    ).toBe(false);
    expect(isMcpToolDisallowed(tool, [])).toBe(false);
  });

  test('only the exact match applies to a non-MCP name', () => {
    expect(isMcpToolDisallowed('Bash', ['Bash'])).toBe(true);
    expect(isMcpToolDisallowed('Bash', ['mcp__*'])).toBe(false);
  });
});

describe('inferRequiredMcpToolsFromProcedure', () => {
  test('requires merge_pr when the procedure references the merge gate', () => {
    const procedure = 'Call the merge gate: merge_pr(pr_url="https://x", task_id="t")';
    expect(inferRequiredMcpToolsFromProcedure(procedure)).toEqual([MERGE_PR_TOOL]);
  });

  test('requires merge_pr for the full built-in merge template', () => {
    // The real merger procedure references merge_pr many times; a representative
    // excerpt is enough — the helper only needs to see the tool token.
    const procedure = [
      'You are the Merger. Your ONLY job is to merge the PR through merge_pr.',
      '1. Call the merge gate: merge_pr(pr_url="{{pr_url}}", task_id="{{task_id}}")',
      'When merge_pr returns blockers, accept them.',
    ].join('\n');
    expect(inferRequiredMcpToolsFromProcedure(procedure)).toEqual([MERGE_PR_TOOL]);
  });

  test('returns nothing for a non-merge procedure', () => {
    expect(inferRequiredMcpToolsFromProcedure('Save an artifact and approve the task.')).toEqual(
      []
    );
  });

  test('does not match merge-pr prose that is not the tool (no false positive)', () => {
    // "re-merge" / "merged" must not trigger the requirement; only the tool
    // token `merge_pr` does.
    expect(inferRequiredMcpToolsFromProcedure('The reviewer may re-merge after changes.')).toEqual(
      []
    );
  });
});

describe('findMissingRequiredMcpTools', () => {
  test('empty when the server is present and not disallowed', () => {
    expect(
      findMissingRequiredMcpTools(
        { mcpServers: { 'space-agent-tools': {}, 'node-agent': {} }, disallowedTools: [] },
        [MERGE_PR_TOOL]
      )
    ).toEqual([]);
  });

  test('reports the tool when its server is absent', () => {
    expect(
      findMissingRequiredMcpTools({ mcpServers: { 'node-agent': {} }, disallowedTools: [] }, [
        MERGE_PR_TOOL,
      ])
    ).toEqual([MERGE_PR_TOOL]);
  });

  test('reports the tool when the server is present but the tool is disallowed', () => {
    expect(
      findMissingRequiredMcpTools(
        { mcpServers: { 'space-agent-tools': {} }, disallowedTools: ['mcp__space-agent-tools__*'] },
        [MERGE_PR_TOOL]
      )
    ).toEqual([MERGE_PR_TOOL]);
  });

  test('no required tools → nothing missing', () => {
    expect(findMissingRequiredMcpTools({ mcpServers: {} }, [])).toEqual([]);
  });

  test('handles a null/undefined surface gracefully', () => {
    expect(findMissingRequiredMcpTools({}, [MERGE_PR_TOOL])).toEqual([MERGE_PR_TOOL]);
    expect(findMissingRequiredMcpTools({ mcpServers: null }, [MERGE_PR_TOOL])).toEqual([
      MERGE_PR_TOOL,
    ]);
  });
});

describe('assertRequiredMcpToolsAvailable', () => {
  const ctx = { sessionId: 's-1', agentName: 'merger', taskId: 't-1' };

  test('does not throw when the required tool is available', () => {
    expect(() =>
      assertRequiredMcpToolsAvailable(
        { mcpServers: { 'space-agent-tools': {} }, disallowedTools: [] },
        [MERGE_PR_TOOL],
        ctx
      )
    ).not.toThrow();
  });

  test('throws a clear error before the merger runs when the server is missing', () => {
    expect(() =>
      assertRequiredMcpToolsAvailable({ mcpServers: { 'node-agent': {} } }, [MERGE_PR_TOOL], ctx)
    ).toThrow(/merge_pr/);
    expect(() =>
      assertRequiredMcpToolsAvailable({ mcpServers: { 'node-agent': {} } }, [MERGE_PR_TOOL], ctx)
    ).toThrow(/prompt\/tool drift/);
  });

  test('throws when the tool is disallowed even with the server present', () => {
    expect(() =>
      assertRequiredMcpToolsAvailable(
        { mcpServers: { 'space-agent-tools': {} }, disallowedTools: ['mcp__space-agent-tools'] },
        [MERGE_PR_TOOL],
        ctx
      )
    ).toThrow(/merge_pr/);
  });

  test('does not throw when there are no required tools', () => {
    expect(() => assertRequiredMcpToolsAvailable({ mcpServers: {} }, [], ctx)).not.toThrow();
  });
});

describe('isDesignatedMergerSession', () => {
  const sessionId = 'space:s1:task:t1:exec:e1';

  test('true only when postApprovalSessionId matches AND the flag is explicitly true', () => {
    expect(
      isDesignatedMergerSession(
        { postApprovalSessionId: sessionId, postApprovalRequiresMerge: true },
        sessionId
      )
    ).toBe(true);
  });

  test('false when the flag is NULL (legacy row — rehydrate lazy-derives it)', () => {
    expect(
      isDesignatedMergerSession(
        { postApprovalSessionId: sessionId, postApprovalRequiresMerge: null },
        sessionId
      )
    ).toBe(false);
  });

  test('false when the flag is explicitly false (a non-merge route)', () => {
    expect(
      isDesignatedMergerSession(
        { postApprovalSessionId: sessionId, postApprovalRequiresMerge: false },
        sessionId
      )
    ).toBe(false);
  });

  test('false when the session id does not match (a different task designates this id)', () => {
    expect(
      isDesignatedMergerSession(
        { postApprovalSessionId: 'some-other-session', postApprovalRequiresMerge: true },
        sessionId
      )
    ).toBe(false);
  });

  test('false for a null/undefined task', () => {
    expect(isDesignatedMergerSession(null, sessionId)).toBe(false);
    expect(isDesignatedMergerSession(undefined, sessionId)).toBe(false);
  });
});

describe('derivePostApprovalRequiresMerge', () => {
  test('true when the first dispatchable node route references merge_pr', () => {
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [
          {
            postApproval: {
              targetAgent: 'merger',
              instructions: 'Call merge_pr(pr_url="x", task_id="t")',
            },
          },
        ],
      })
    ).toBe(true);
  });

  test('true for the legacy workflow-level route (no node routes)', () => {
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [],
        postApproval: { targetAgent: 'merger', instructions: 'merge_pr(...) then mark_complete' },
      })
    ).toBe(true);
  });

  test('false when the first dispatchable route is non-merge', () => {
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [{ postApproval: { targetAgent: 'deployer', instructions: 'save_artifact' } }],
      })
    ).toBe(false);
  });

  test('only the FIRST dispatchable route counts — a later merge route does not over-provision (#879 3740839498)', () => {
    // The router dispatches only the first dispatchable route. A custom workflow
    // whose first route is non-merge but a later route mentions merge_pr must NOT
    // be classified as a merge route (the dispatched worker would be over-provisioned
    // space-agent-tools + merge-authorized via loadAuthorizedTask).
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [
          { postApproval: { targetAgent: 'deployer', instructions: 'save_artifact' } },
          { postApproval: { targetAgent: 'merger', instructions: 'merge_pr(...)' } },
        ],
      })
    ).toBe(false);
  });

  test('node routes suppress the legacy workflow-level route', () => {
    // collectPostApprovalRoutes returns node routes alone when any exist; the
    // legacy workflow-level route is ignored. Here the node route is non-merge,
    // so even though the legacy route mentions merge_pr, the result is false.
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [{ postApproval: { targetAgent: 'deployer', instructions: 'save_artifact' } }],
        postApproval: { targetAgent: 'merger', instructions: 'merge_pr(...)' },
      })
    ).toBe(false);
  });

  test('skips non-dispatchable routes (no targetAgent or legacy "task-agent")', () => {
    // A route with no targetAgent, and the legacy 'task-agent' target, are both
    // non-dispatchable and skipped by the router. A following dispatchable merge
    // route is then the first dispatchable one.
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [
          { postApproval: { instructions: 'merge_pr(...)' } }, // no targetAgent → skipped
          { postApproval: { targetAgent: 'task-agent', instructions: 'merge_pr(...)' } }, // legacy → skipped
          { postApproval: { targetAgent: 'merger', instructions: 'merge_pr(...)' } }, // first dispatchable
        ],
      })
    ).toBe(true);
  });

  test('false for a null workflow (no route to derive from)', () => {
    expect(derivePostApprovalRequiresMerge(null)).toBe(false);
  });

  test('derives from the un-interpolated template (merge_pr is a literal token)', () => {
    // Stored workflow instructions are templates ({{pr_url}}); the merge_pr token
    // is literal, so detection works pre-interpolation — this is what rehydrate
    // reads for a legacy NULL row.
    expect(
      derivePostApprovalRequiresMerge({
        nodes: [
          {
            postApproval: {
              targetAgent: 'merger',
              instructions: 'merge_pr(pr_url="{{pr_url}}", task_id="{{task_id}}")',
            },
          },
        ],
      })
    ).toBe(true);
  });
});
