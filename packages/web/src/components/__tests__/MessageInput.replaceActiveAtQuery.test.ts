import { describe, it, expect } from 'vitest';
import { replaceActiveAtQuery } from '../MessageInput';

describe('replaceActiveAtQuery', () => {
  it('replaces a bare @ at the end of content', () => {
    expect(replaceActiveAtQuery('@', 'task', 't-1')).toBe('@ref{task:t-1} ');
  });

  it('replaces @query at the end of content', () => {
    expect(replaceActiveAtQuery('@fix', 'task', 't-1')).toBe('@ref{task:t-1} ');
  });

  it('replaces @query after a space', () => {
    expect(replaceActiveAtQuery('hello @fix', 'task', 't-1')).toBe('hello @ref{task:t-1} ');
  });

  it('preserves prefix text before the @query', () => {
    expect(replaceActiveAtQuery('please look at @auth', 'file', 'src/auth.ts')).toBe(
      'please look at @ref{file:src/auth.ts} '
    );
  });

  it('only replaces the active (last) @query', () => {
    expect(replaceActiveAtQuery('@ref{task:t-1}  @fix', 'task', 't-2')).toBe(
      '@ref{task:t-1}  @ref{task:t-2} '
    );
  });

  it('returns original content when there is no active @query', () => {
    expect(replaceActiveAtQuery('hello world ', 'task', 't-1')).toBe('hello world ');
  });

  it('returns original content when content has no @ at all', () => {
    expect(replaceActiveAtQuery('just some text', 'task', 't-1')).toBe('just some text');
  });

  it('handles empty content', () => {
    expect(replaceActiveAtQuery('', 'task', 't-1')).toBe('');
  });

  it('appends a trailing space to prevent re-triggering autocomplete', () => {
    const result = replaceActiveAtQuery('@foo', 'goal', 'g-99');
    expect(result).toMatch(/ $/);
  });

  it('works with folder type and id containing slashes', () => {
    expect(replaceActiveAtQuery('@src/', 'folder', 'src/')).toBe('@ref{folder:src/} ');
  });

  it('works with goal type', () => {
    expect(replaceActiveAtQuery('achieve @launch', 'goal', 'g-42')).toBe(
      'achieve @ref{goal:g-42} '
    );
  });
});
