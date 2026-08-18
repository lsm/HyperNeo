import { describe, test, expect } from 'bun:test';
import { BUILTIN_MCP_SERVERS, BUILTIN_SKILLS } from '../../../src/lib/builtins';

describe('Built-ins registry — BUILTIN_MCP_SERVERS', () => {
  test('all MCP server names are unique', () => {
    const names = BUILTIN_MCP_SERVERS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('all MCP servers have non-empty command and args', () => {
    for (const s of BUILTIN_MCP_SERVERS) {
      expect(s.command.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(s.args)).toBe(true);
    }
  });

  test('every MCP server has a non-empty description', () => {
    for (const s of BUILTIN_MCP_SERVERS) {
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('does not include the removed Brave Search MCP server', () => {
    const serialized = JSON.stringify(BUILTIN_MCP_SERVERS).toLowerCase();

    expect(serialized).not.toContain('brave');
    expect(serialized).not.toContain('server-brave-search');
    expect(BUILTIN_MCP_SERVERS.map((s) => s.name)).not.toContain('brave-search');
  });
});

describe('Built-ins registry — BUILTIN_SKILLS', () => {
  test('all skill names are unique', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('every mcp_server skill references an entry in BUILTIN_MCP_SERVERS', () => {
    const serverNames = new Set(BUILTIN_MCP_SERVERS.map((s) => s.name));
    for (const skill of BUILTIN_SKILLS) {
      if (skill.kind === 'mcp_server') {
        expect(serverNames.has(skill.appMcpServerName)).toBe(true);
      }
    }
  });

  test('every builtin-command skill has a non-empty commandName', () => {
    for (const skill of BUILTIN_SKILLS) {
      if (skill.kind === 'builtin-command') {
        expect(skill.commandName.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('every skill has non-empty displayName and description', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.displayName.trim().length).toBeGreaterThan(0);
      expect(skill.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('does not include the removed Brave Search MCP skill', () => {
    const serialized = JSON.stringify(BUILTIN_SKILLS).toLowerCase();
    const names = BUILTIN_SKILLS.map((s) => s.name);

    expect(serialized).not.toContain('brave');
    expect(names).not.toContain('web-search-mcp');
  });
});
