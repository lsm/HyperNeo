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
  findMissingRequiredMcpTools,
  inferRequiredMcpToolsFromProcedure,
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
