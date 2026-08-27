import { describe, test, expect } from 'bun:test';
import { resolveWorkspaceMcpServerName } from '../../../../src/lib/mcp/mcp-server-namespace';

describe('resolveWorkspaceMcpServerName', () => {
  test('prefixes a server name with a non-empty workspace label', () => {
    const reserved = new Set<string>();
    const result = resolveWorkspaceMcpServerName({
      label: 'repo-a',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('repo-a:fetch');
  });

  test('uses the bare server name when the workspace label is empty', () => {
    const reserved = new Set<string>();
    const result = resolveWorkspaceMcpServerName({
      label: '',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('fetch');
  });

  test('does not collide when the same server name appears under a different label', () => {
    const reserved = new Set<string>(['repo-a:fetch']);
    const result = resolveWorkspaceMcpServerName({
      label: 'repo-b',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('repo-b:fetch');
  });

  test('does not collide when the same label serves a different server name', () => {
    const reserved = new Set<string>(['repo-a:fetch']);
    const result = resolveWorkspaceMcpServerName({
      label: 'repo-a',
      serverName: 'memory',
      reserved,
    });
    expect(result).toBe('repo-a:memory');
  });

  test('appends a numeric suffix when the base name is already reserved', () => {
    const reserved = new Set<string>(['repo-a:fetch']);
    const result = resolveWorkspaceMcpServerName({
      label: 'repo-a',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('repo-a:fetch:2');
  });

  test('increments the suffix until it finds an unused name', () => {
    const reserved = new Set<string>(['repo-a:fetch', 'repo-a:fetch:2', 'repo-a:fetch:3']);
    const result = resolveWorkspaceMcpServerName({
      label: 'repo-a',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('repo-a:fetch:4');
  });

  test('resolves collisions for unlabeled servers with the same suffix scheme', () => {
    const reserved = new Set<string>(['fetch', 'fetch:2']);
    const result = resolveWorkspaceMcpServerName({
      label: '',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('fetch:3');
  });

  test('treats a reserved suffixed name as a separate collision candidate', () => {
    const reserved = new Set<string>(['repo-a:fetch:2']);
    const result = resolveWorkspaceMcpServerName({
      label: 'repo-a',
      serverName: 'fetch',
      reserved,
    });
    expect(result).toBe('repo-a:fetch');
  });

  test('does not mutate the provided reserved set', () => {
    const reserved = new Set<string>();
    resolveWorkspaceMcpServerName({
      label: 'repo-a',
      serverName: 'fetch',
      reserved,
    });
    expect(reserved.size).toBe(0);
  });
});
