import { describe, expect, test } from 'bun:test';
import { neoReadTools } from '../../../../src/lib/neo/session-config.ts';

describe('neo wait admission', () => {
  test('the read preset admits bounded sleep waits', () => {
    const tools = neoReadTools();
    expect(tools.permissionMode).toBe('dontAsk');
    expect(tools.allowedTools).toContain('Bash(sleep *)');
  });
});
