import { describe, expect, test } from 'bun:test';
import { neoSecretReadRules } from '../../../../src/lib/neo/secret-read-rules.ts';
import { neoReadTools } from '../../../../src/lib/neo/session-config.ts';

describe('neo read admission', () => {
  test('secret read rules keep credential protection and drop blanket directory bans', () => {
    const rules = neoSecretReadRules();
    for (const kept of [
      'Read(~/.ssh/**)',
      'Read(~/.aws/**)',
      'Read(~/.gnupg/**)',
      'Read(~/.claude/.credentials.json)',
      'Read(~/.git-credentials)',
      'Read(~/**/.env)',
      'Read(~/**/*.pem)',
      'Read(~/.config/gcloud/**)',
      'Read(~/.config/gh/**)',
      'Read(~/Library/Keychains/**)',
    ])
      expect(rules).toContain(kept);
    for (const dropped of [
      'Read(~/Library/**)',
      'Read(~/.config/**)',
      'Read(~/.claude/projects/**)',
    ])
      expect(rules).not.toContain(dropped);
  });

  test('the read preset admits the builtin fetch server tools under dontAsk', () => {
    const tools = neoReadTools();
    expect(tools.permissionMode).toBe('dontAsk');
    expect(tools.allowedTools).toContain('mcp__fetch-mcp');
    expect(tools.allowedTools).toContain('Read');
    expect(tools.allowedTools).toContain('Grep');
  });
});
