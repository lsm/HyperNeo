import { describe, expect, test } from 'bun:test';
import { neoReadTools } from '../../../../src/lib/neo/session-config.ts';
import { extractBashScopePrefixes } from '../../../../src/lib/agent/bash-scope.ts';

describe('neo wait admission', () => {
  test('the read preset does not admit wait commands; Neo ends the turn instead', () => {
    const tools = neoReadTools();
    expect(tools.permissionMode).toBe('dontAsk');
    expect(tools.allowedTools).not.toContain('Bash(sleep:*)');
    expect(tools.allowedTools.filter((tool) => tool.startsWith('Bash('))).toEqual([]);
  });

  test('the preset carries no sleep scope entry', () => {
    expect(extractBashScopePrefixes(neoReadTools().allowedTools)).toEqual([]);
  });
});
