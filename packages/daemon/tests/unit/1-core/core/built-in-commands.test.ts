import { describe, expect, it } from 'bun:test';
import {
  getBuiltInCommandNames,
  expandBuiltInCommand,
} from '../../../../src/lib/built-in-commands';

describe('Built-in Commands', () => {
  describe('getBuiltInCommandNames', () => {
    it('should return an array of command names', () => {
      const names = getBuiltInCommandNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
    });

    it('should include merge-session command', () => {
      const names = getBuiltInCommandNames();
      expect(names).toContain('merge-session');
    });

    it('should return strings only', () => {
      const names = getBuiltInCommandNames();
      for (const name of names) {
        expect(typeof name).toBe('string');
      }
    });
  });

  describe('expandBuiltInCommand', () => {
    it('should expand merge-session command', () => {
      const result = expandBuiltInCommand('/merge-session');
      expect(result).not.toBeNull();
      expect(result).toContain('worktree');
      expect(result).toContain('commit');
    });

    it('should return null for non-command text', () => {
      const result = expandBuiltInCommand('Hello, how are you?');
      expect(result).toBeNull();
    });

    it('should return null for unknown commands', () => {
      const result = expandBuiltInCommand('/unknown-command');
      expect(result).toBeNull();
    });

    it('should handle command with leading/trailing whitespace', () => {
      const result = expandBuiltInCommand('  /merge-session  ');
      expect(result).not.toBeNull();
    });

    it('should handle command with additional arguments', () => {
      const result = expandBuiltInCommand('/merge-session --force');
      expect(result).not.toBeNull();
    });

    it('should return null for text that looks like command but is not', () => {
      const result = expandBuiltInCommand('// This is a comment');
      expect(result).toBeNull();
    });

    it('should return null for empty string', () => {
      const result = expandBuiltInCommand('');
      expect(result).toBeNull();
    });

    it('should return null for just a slash', () => {
      const result = expandBuiltInCommand('/');
      expect(result).toBeNull();
    });

    it('should be case-sensitive for command names', () => {
      const result = expandBuiltInCommand('/MERGE-SESSION');
      expect(result).toBeNull();
    });

    it('should extract command name correctly when followed by space', () => {
      const result = expandBuiltInCommand('/merge-session some extra text');
      expect(result).not.toBeNull();
    });
  });

  describe('command prompt content', () => {
    it('merge-session should include git workflow steps', () => {
      const result = expandBuiltInCommand('/merge-session')!;
      const lower = result.toLowerCase();
      expect(lower).toContain('commit');
      expect(lower).toContain('rebase');
      expect(lower).toContain('merge');
      expect(lower).toContain('push');
    });

    it('merge-session should mention fast-forward', () => {
      const result = expandBuiltInCommand('/merge-session')!;
      expect(result.toLowerCase()).toContain('fast-forward');
    });
  });
});
