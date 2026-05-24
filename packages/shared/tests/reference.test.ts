import { describe, expect, it } from 'bun:test';
import type {
  ReferenceMention,
  ReferenceMetadata,
  ReferenceSearchResult,
  ResolvedFileReference,
  ResolvedFolderReference,
  ResolvedGoalReference,
  ResolvedReference,
  ResolvedTaskReference,
  ReferenceType,
} from '../src/types/reference.ts';
import { REFERENCE_PATTERN } from '../src/types/reference.ts';

describe('ReferenceType', () => {
  it('accepts all valid values', () => {
    const valid: ReferenceType[] = ['task', 'goal', 'file', 'folder'];
    expect(valid).toHaveLength(4);
  });
});

describe('ReferenceMention', () => {
  it('has the expected shape', () => {
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
  it('includes optional fields', () => {
    const result: ReferenceSearchResult = {
      type: 'goal',
      id: 'g-1',
      shortId: 'g-1',
      displayText: 'Improve performance',
      subtitle: 'Measurable goal',
    };
    expect(result.shortId).toBe('g-1');
    expect(result.subtitle).toBe('Measurable goal');
  });

  it('works without optional fields', () => {
    const result: ReferenceSearchResult = {
      type: 'file',
      id: 'src/index.ts',
      displayText: 'src/index.ts',
    };
    expect(result.shortId).toBeUndefined();
    expect(result.subtitle).toBeUndefined();
  });
});

describe('ResolvedReference variants', () => {
  it('ResolvedTaskReference has type task', () => {
    const ref: ResolvedTaskReference = {
      type: 'task',
      id: 't-1',
      data: { title: 'A task' },
    };
    expect(ref.type).toBe('task');
  });

  it('ResolvedGoalReference has type goal', () => {
    const ref: ResolvedGoalReference = {
      type: 'goal',
      id: 'g-1',
      data: {},
    };
    expect(ref.type).toBe('goal');
  });

  it('ResolvedFileReference has type file', () => {
    const ref: ResolvedFileReference = {
      type: 'file',
      id: 'src/app.ts',
      data: {
        path: 'src/app.ts',
        content: 'console.log("hello");',
        binary: false,
        truncated: false,
        size: 21,
        mtime: new Date().toISOString(),
      },
    };
    expect(ref.type).toBe('file');
    expect(ref.data.binary).toBe(false);
  });

  it('ResolvedFileReference supports binary files with null content', () => {
    const ref: ResolvedFileReference = {
      type: 'file',
      id: 'image.png',
      data: {
        path: 'image.png',
        content: null,
        binary: true,
        truncated: false,
        size: 1024,
        mtime: new Date().toISOString(),
      },
    };
    expect(ref.data.binary).toBe(true);
    expect(ref.data.content).toBeNull();
  });

  it('ResolvedFolderReference has type folder', () => {
    const ref: ResolvedFolderReference = {
      type: 'folder',
      id: 'src/',
      data: {
        path: 'src/',
        entries: [
          { name: 'app.ts', path: 'src/app.ts', type: 'file' },
          { name: 'index.ts', path: 'src/index.ts', type: 'file' },
        ],
      },
    };
    expect(ref.type).toBe('folder');
    expect(ref.data.entries).toHaveLength(2);
  });

  it('ResolvedReference accepts unknown data', () => {
    const ref: ResolvedReference = { type: 'task', id: 't-99', data: null };
    expect(ref.data).toBeNull();
  });
});

describe('ReferenceMetadata', () => {
  it('stores references keyed by serialized string', () => {
    const meta: ReferenceMetadata = {
      '@ref{task:t-42}': {
        type: 'task',
        id: 't-42',
        displayText: 'Fix the bug',
        status: 'in_progress',
      },
      '@ref{goal:g-1}': {
        type: 'goal',
        id: 'g-1',
        displayText: 'Improve performance',
      },
    };
    expect(meta['@ref{task:t-42}'].status).toBe('in_progress');
    expect(meta['@ref{goal:g-1}'].status).toBeUndefined();
  });

  it('round-trips through JSON serialization', () => {
    const meta: ReferenceMetadata = {
      '@ref{file:src/index.ts}': {
        type: 'file',
        id: 'src/index.ts',
        displayText: 'src/index.ts',
      },
    };
    const parsed = JSON.parse(JSON.stringify(meta)) as ReferenceMetadata;
    expect(parsed['@ref{file:src/index.ts}'].type).toBe('file');
  });
});

describe('REFERENCE_PATTERN', () => {
  it('matches @ref{task:t-42}', () => {
    const matches = [...'hello @ref{task:t-42} world'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('task');
    expect(matches[0][2]).toBe('t-42');
  });

  it('matches @ref{goal:g-abc}', () => {
    const matches = [...'@ref{goal:g-abc}'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('goal');
    expect(matches[0][2]).toBe('g-abc');
  });

  it('matches @ref{file:src/index.ts} with path separator', () => {
    const matches = [...'@ref{file:src/index.ts}'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('file');
    expect(matches[0][2]).toBe('src/index.ts');
  });

  it('matches multiple references in one string', () => {
    const text = 'Fix @ref{task:t-1} related to @ref{goal:g-2}';
    const matches = [...text.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(2);
  });

  it('does not match normal markdown links', () => {
    const matches = [...'[link](https://example.com)'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  it('does not match plain @ mentions', () => {
    const matches = [...'hello @user'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  it('does not match @ref without braces', () => {
    const matches = [...'@ref task:t-42'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  it('does not match @ref{} with missing colon separator', () => {
    const matches = [...'@ref{taskt42}'.matchAll(REFERENCE_PATTERN)];
    expect(matches).toHaveLength(0);
  });
});
