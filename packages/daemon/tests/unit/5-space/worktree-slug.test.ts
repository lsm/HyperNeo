import { describe, test, expect } from 'bun:test';
import { worktreeSlug } from '../../../src/lib/space/worktree-slug';

describe('worktreeSlug', () => {
  describe('empty / whitespace-only titles — fallback to task-{taskNumber}', () => {
    test('empty string falls back to task-{taskNumber}', () => {
      expect(worktreeSlug('', 1)).toBe('task-1');
    });

    test('whitespace-only falls back to task-{taskNumber}', () => {
      expect(worktreeSlug('   ', 5)).toBe('task-5');
    });

    test('tab-only falls back to task-{taskNumber}', () => {
      expect(worktreeSlug('\t\n', 3)).toBe('task-3');
    });

    test('title with only special characters falls back to task-{taskNumber}', () => {
      expect(worktreeSlug('!!!@@@', 7)).toBe('task-7');
    });
  });

  describe('normal titles — delegate to slugify()', () => {
    test('simple title is slugified correctly', () => {
      expect(worktreeSlug('Add authentication', 1)).toBe('add-authentication');
    });

    test('title with mixed case is lowercased', () => {
      expect(worktreeSlug('Fix Bug In Parser', 2)).toBe('fix-bug-in-parser');
    });

    test('title with special characters is cleaned up', () => {
      expect(worktreeSlug('Implement OAuth2.0 (v2)', 3)).toBe('implement-oauth2-0-v2');
    });

    test('title with consecutive spaces/hyphens is normalised', () => {
      expect(worktreeSlug('foo---bar  baz', 4)).toBe('foo-bar-baz');
    });

    test('task number does not appear in slug when title is non-empty', () => {
      const slug = worktreeSlug('Refactor database layer', 99);
      expect(slug).not.toContain('99');
      expect(slug).toBe('refactor-database-layer');
    });

    // Regression: titles that happen to produce 'unnamed-space' when slugified
    // must NOT fall back to task-{taskNumber} — the sentinel-value check was
    // removed in favour of testing the raw input for alphanumeric content.
    test('title "unnamed-space" is NOT treated as a fallback trigger', () => {
      expect(worktreeSlug('unnamed-space', 5)).toBe('unnamed-space');
    });

    test('title "Unnamed Space" is NOT treated as a fallback trigger', () => {
      expect(worktreeSlug('Unnamed Space', 5)).toBe('unnamed-space');
    });
  });

  describe('collision handling', () => {
    test('appends -2 suffix when slug already exists', () => {
      expect(worktreeSlug('Add feature', 1, ['add-feature'])).toBe('add-feature-2');
    });

    test('increments suffix until unique', () => {
      expect(worktreeSlug('Add feature', 1, ['add-feature', 'add-feature-2'])).toBe(
        'add-feature-3'
      );
    });

    test('fallback slug gets collision suffix when task-N exists', () => {
      expect(worktreeSlug('', 2, ['task-2'])).toBe('task-2-2');
    });

    test('fallback collision increments correctly', () => {
      expect(worktreeSlug('', 2, ['task-2', 'task-2-2'])).toBe('task-2-3');
    });

    // Regression: all-special-chars title with 'unnamed-space' already taken must
    // fall back to task-N, not 'unnamed-space-2'.
    test('all-special-chars title with unnamed-space taken still uses task-N fallback', () => {
      expect(worktreeSlug('!!!', 7, ['unnamed-space'])).toBe('task-7');
    });

    test('no collision when existingSlugs is empty', () => {
      expect(worktreeSlug('my task', 1, [])).toBe('my-task');
    });

    test('no collision when slug is not in existingSlugs', () => {
      expect(worktreeSlug('my task', 1, ['other-slug'])).toBe('my-task');
    });
  });

  describe('task number variants', () => {
    test('uses the correct task number in fallback', () => {
      expect(worktreeSlug('', 42)).toBe('task-42');
    });

    test('task number 0 is valid', () => {
      expect(worktreeSlug('', 0)).toBe('task-0');
    });

    test('large task number works', () => {
      expect(worktreeSlug('', 9999)).toBe('task-9999');
    });
  });
});
