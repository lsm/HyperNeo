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
    const values: ReferenceType[] = ['file', 'folder'];
    expect(values).toHaveLength(2);
  });
});

describe('ReferenceMention', () => {
  it('has correct shape', () => {
    const mention: ReferenceMention = {
      type: 'folder',
      id: 'src/lib',
      displayText: 'lib',
    };
    expect(mention.type).toBe('folder');
    expect(mention.id).toBe('src/lib');
    expect(mention.displayText).toBe('lib');
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
      type: 'folder',
      id: 'src/lib',
      shortId: 'lib',
      displayText: 'lib',
      subtitle: 'src/lib',
    };
    expect(result.shortId).toBe('lib');
    expect(result.subtitle).toBe('src/lib');
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
      '@ref{file:src/app.ts}': {
        type: 'file',
        id: 'src/app.ts',
        displayText: 'app.ts',
        status: 'unresolved',
      },
    };
    const serialized = JSON.stringify(meta);
    const parsed = JSON.parse(serialized) as ReferenceMetadata;
    expect(parsed['@ref{file:src/app.ts}'].type).toBe('file');
    expect(parsed['@ref{file:src/app.ts}'].status).toBe('unresolved');
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
