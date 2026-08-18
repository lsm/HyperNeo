import { describe, it, expect } from 'bun:test';
import {
  REFERENCE_PATTERN,
  type ReferenceType,
  type ReferenceMention,
  type ReferenceSearchResult,
  type ResolvedReference,
  type ReferenceMetadata,
} from '../../src/types/reference.ts';

describe('ReferenceType', () => {
  it('accepts all valid values', () => {
    const values: ReferenceType[] = ['task', 'goal', 'file', 'folder'];
    expect(values).toHaveLength(4);
  });
});

describe('ReferenceMention', () => {
  it('has correct shape', () => {
    const mention: ReferenceMention = {
      type: 'task',
      id: 't-42',
      displayText: 'Fix the bug',
    };
    expect(mention.type).toBe('task');
    expect(mention.id).toBe('t-42');
    expect(mention.displayText).toBe('Fix the bug');
  });
});

describe('ReferenceSearchResult', () => {
  it('accepts optional fields', () => {
    const result: ReferenceSearchResult = {
      type: 'file',
      id: 'src/foo.ts',
      displayText: 'foo.ts',
    };
    expect(result.shortId).toBeUndefined();
    expect(result.subtitle).toBeUndefined();
  });

  it('includes optional fields when provided', () => {
    const result: ReferenceSearchResult = {
      type: 'task',
      id: 'task-uuid-42',
      shortId: 't-42',
      displayText: 'Fix the bug',
      subtitle: 'in progress',
    };
    expect(result.shortId).toBe('t-42');
    expect(result.subtitle).toBe('in progress');
  });
});

describe('ResolvedReference', () => {
  it('has polymorphic data field', () => {
    const resolved: ResolvedReference = {
      type: 'file',
      id: 'src/foo.ts',
      data: { path: 'src/foo.ts', content: 'export {}' },
    };
    expect(resolved.data).toBeDefined();
  });
});

describe('ReferenceMetadata', () => {
  it('is a plain object (JSON-serializable)', () => {
    const meta: ReferenceMetadata = {
      '@ref{task:t-42}': {
        type: 'task',
        id: 't-42',
        displayText: 'Fix the bug',
        status: 'in_progress',
      },
    };
    const serialized = JSON.stringify(meta);
    const parsed = JSON.parse(serialized) as ReferenceMetadata;
    expect(parsed['@ref{task:t-42}'].type).toBe('task');
    expect(parsed['@ref{task:t-42}'].status).toBe('in_progress');
  });
});

describe('REFERENCE_PATTERN', () => {
  it('matches task reference', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('@ref{task:t-42}');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('task');
    expect(m![2]).toBe('t-42');
  });

  it('matches goal reference', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('@ref{goal:g-7}');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('goal');
    expect(m![2]).toBe('g-7');
  });

  it('matches file reference with path', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('@ref{file:src/components/Foo.tsx}');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('file');
    expect(m![2]).toBe('src/components/Foo.tsx');
  });

  it('matches folder reference', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('@ref{folder:packages/web}');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('folder');
    expect(m![2]).toBe('packages/web');
  });

  it('finds multiple references in text', () => {
    const text = 'Fix @ref{task:t-42} in @ref{file:src/foo.ts}';
    REFERENCE_PATTERN.lastIndex = 0;
    const matches: string[] = [];
    let m;
    while ((m = REFERENCE_PATTERN.exec(text)) !== null) {
      matches.push(m[0]);
    }
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe('@ref{task:t-42}');
    expect(matches[1]).toBe('@ref{file:src/foo.ts}');
  });

  it('does not match plain @mentions', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('@username');
    expect(m).toBeNull();
  });

  it('does not match markdown links', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('[link](https://example.com)');
    expect(m).toBeNull();
  });

  it('does not match malformed ref without colon', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const m = REFERENCE_PATTERN.exec('@ref{taskonly}');
    expect(m).toBeNull();
  });
});
