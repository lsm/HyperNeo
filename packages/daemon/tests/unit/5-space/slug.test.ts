import { describe, test, expect } from 'bun:test';
import { slugify, validateSlug } from '../../../src/lib/space/slug';

describe('slugify', () => {
  test('converts simple name to lowercase slug', () => {
    expect(slugify('HyperNeo Dev')).toBe('hyperneo-dev');
  });

  test('replaces non-alphanumeric characters with hyphens', () => {
    expect(slugify('My Project (v2.0)')).toBe('my-project-v2-0');
  });

  test('collapses consecutive hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  test('strips leading and trailing hyphens', () => {
    expect(slugify('--hello-world--')).toBe('hello-world');
  });

  test('handles empty string', () => {
    expect(slugify('')).toBe('unnamed-space');
  });

  test('handles whitespace-only string', () => {
    expect(slugify('   ')).toBe('unnamed-space');
  });

  test('handles string with only special characters', () => {
    expect(slugify('!!!@@@')).toBe('unnamed-space');
  });

  test('truncates long names at word boundary', () => {
    const longName =
      'this-is-a-very-long-space-name-that-exceeds-the-maximum-allowed-length-of-sixty-characters';
    const slug = slugify(longName);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toEndWith('-');
  });

  test('truncates at hyphen boundary when possible', () => {
    // Create a name that exceeds 60 chars and has hyphens before the cutoff
    const name = 'abcdefghij-klmnopqrst-uvwxyzabcd-efghijklmn-opqrstuvwx-yzab-cdef';
    const slug = slugify(name);
    expect(slug.length).toBeLessThanOrEqual(60);
    // Should truncate at a hyphen boundary
    expect(slug).not.toEndWith('-');
  });

  test('resolves collision with first suffix -2', () => {
    expect(slugify('my-project', ['my-project'])).toBe('my-project-2');
  });

  test('resolves multiple collisions incrementally', () => {
    expect(slugify('my-project', ['my-project', 'my-project-2', 'my-project-3'])).toBe(
      'my-project-4'
    );
  });

  test('no collision suffix when no conflict', () => {
    expect(slugify('unique-name', ['other-name'])).toBe('unique-name');
  });

  test('handles unicode characters', () => {
    expect(slugify('Café Résumé')).toBe('caf-r-sum');
  });

  test('handles numbers in name', () => {
    expect(slugify('Project 42')).toBe('project-42');
  });

  test('handles mixed case', () => {
    expect(slugify('MyAwesomeProject')).toBe('myawesomeproject');
  });

  test('handles dots and underscores', () => {
    expect(slugify('my.project_name')).toBe('my-project-name');
  });
});

describe('validateSlug', () => {
  test('accepts valid slug', () => {
    expect(validateSlug('hyperneo-dev')).toBeNull();
  });

  test('accepts single character slug', () => {
    expect(validateSlug('a')).toBeNull();
  });

  test('accepts numeric slug', () => {
    expect(validateSlug('123')).toBeNull();
  });

  test('accepts alphanumeric with hyphens', () => {
    expect(validateSlug('my-project-2')).toBeNull();
  });

  test('rejects empty slug', () => {
    expect(validateSlug('')).not.toBeNull();
  });

  test('rejects slug with uppercase', () => {
    expect(validateSlug('MyProject')).not.toBeNull();
  });

  test('rejects slug starting with hyphen', () => {
    expect(validateSlug('-my-project')).not.toBeNull();
  });

  test('rejects slug ending with hyphen', () => {
    expect(validateSlug('my-project-')).not.toBeNull();
  });

  test('rejects slug with consecutive hyphens', () => {
    expect(validateSlug('my--project')).not.toBeNull();
  });

  test('rejects slug with spaces', () => {
    expect(validateSlug('my project')).not.toBeNull();
  });

  test('rejects slug with special characters', () => {
    expect(validateSlug('my@project')).not.toBeNull();
  });

  test('rejects slug exceeding max length', () => {
    const longSlug = 'a'.repeat(61);
    expect(validateSlug(longSlug)).not.toBeNull();
  });

  test('accepts slug at max length', () => {
    const maxSlug = 'a'.repeat(60);
    expect(validateSlug(maxSlug)).toBeNull();
  });
});
