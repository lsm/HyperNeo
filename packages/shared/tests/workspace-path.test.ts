import { describe, it, expect } from 'bun:test';
import { validateWorkspacePath } from '../src/validation/workspace-path.ts';

describe('validateWorkspacePath', () => {
  it('returns valid for a normal absolute path', () => {
    const result = validateWorkspacePath('/home/user/project');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns valid for an absolute path with trailing slash', () => {
    const result = validateWorkspacePath('/home/user/project/');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns invalid for an empty string', () => {
    const result = validateWorkspacePath('');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns invalid for a whitespace-only string', () => {
    const result = validateWorkspacePath('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns invalid for a relative path', () => {
    const result = validateWorkspacePath('relative/path/to/project');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('absolute');
  });

  it('returns invalid for a path starting with ./', () => {
    const result = validateWorkspacePath('./local/path');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns valid for root path', () => {
    const result = validateWorkspacePath('/');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns valid for a deeply nested absolute path', () => {
    const result = validateWorkspacePath('/usr/local/share/projects/my-app');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
