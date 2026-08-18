import { describe, it, expect } from 'bun:test';
import {
  buildReferenceContext,
  prependContextToMessage,
  MAX_CONTEXT_BYTES,
} from '../../../src/lib/agent/reference-context-builder';
import type { ResolvedReference } from '@hyperneo/shared';

const taskRef: ResolvedReference = {
  type: 'task',
  id: 'task-uuid-1',
  data: {
    id: 'task-uuid-1',
    shortId: 't-1',
    title: 'Fix login bug',
    status: 'in_progress',
    priority: 'high',
    progress: 50,
    description: 'Users cannot log in with OAuth',
    currentStep: 'Investigating token refresh',
    roomId: 'room-1',
  },
};

const goalRef: ResolvedReference = {
  type: 'goal',
  id: 'goal-uuid-1',
  data: {
    id: 'goal-uuid-1',
    shortId: 'g-1',
    title: 'Launch v2',
    missionType: 'measurable',
    status: 'active',
    progress: 30,
    description: 'Release the v2 product',
    structuredMetrics: [
      { name: 'features', current: 3, target: 10 },
      { name: 'coverage', current: 70, target: 90, unit: '%' },
    ],
    roomId: 'room-1',
  },
};

const fileRef: ResolvedReference = {
  type: 'file',
  id: 'src/lib/utils.ts',
  data: {
    path: 'src/lib/utils.ts',
    content: 'export function add(a: number, b: number) { return a + b; }',
    binary: false,
    truncated: false,
  },
};

const binaryFileRef: ResolvedReference = {
  type: 'file',
  id: 'assets/logo.png',
  data: {
    path: 'assets/logo.png',
    content: null,
    binary: true,
    truncated: false,
  },
};

const nullContentFileRef: ResolvedReference = {
  type: 'file',
  id: 'src/missing.ts',
  data: {
    path: 'src/missing.ts',
    content: null,
    binary: false,
    truncated: false,
  },
};

const truncatedFileRef: ResolvedReference = {
  type: 'file',
  id: 'src/large.ts',
  data: {
    path: 'src/large.ts',
    content: 'very long file content...',
    binary: false,
    truncated: true,
  },
};

const folderRef: ResolvedReference = {
  type: 'folder',
  id: 'src/lib',
  data: {
    path: 'src/lib',
    entries: [
      { name: 'utils.ts', type: 'file' },
      { name: 'components', type: 'directory' },
    ],
  },
};

const emptyFolderRef: ResolvedReference = {
  type: 'folder',
  id: 'src/empty',
  data: {
    path: 'src/empty',
    entries: [],
  },
};

describe('buildReferenceContext', () => {
  it('returns empty string for empty references map', () => {
    expect(buildReferenceContext({})).toBe('');
  });

  it('formats a task reference', () => {
    const result = buildReferenceContext({ '@ref{task:task-uuid-1}': taskRef });
    expect(result).toContain('### Task: t-1');
    expect(result).toContain('**Title:** Fix login bug');
    expect(result).toContain('**Status:** in_progress');
    expect(result).toContain('**Priority:** high');
    expect(result).toContain('**Progress:** 50%');
    expect(result).toContain('**Description:** Users cannot log in with OAuth');
    expect(result).toContain('**Current Step:** Investigating token refresh');
  });

  it('uses fallback id when task has no shortId', () => {
    const ref: ResolvedReference = {
      type: 'task',
      id: 'task-uuid-2',
      data: {
        id: 'task-uuid-2',
        shortId: null,
        title: 'No short id task',
        status: 'pending',
        priority: 'low',
        roomId: 'room-1',
      },
    };
    const result = buildReferenceContext({ '@ref{task:task-uuid-2}': ref });
    expect(result).toContain('### Task: task-uuid-2');
  });

  it('omits optional task fields when absent', () => {
    const ref: ResolvedReference = {
      type: 'task',
      id: 'task-uuid-3',
      data: {
        id: 'task-uuid-3',
        shortId: 't-3',
        title: 'Minimal task',
        status: 'pending',
        priority: 'medium',
        roomId: 'room-1',
      },
    };
    const result = buildReferenceContext({ '@ref{task:task-uuid-3}': ref });
    expect(result).not.toContain('**Progress:**');
    expect(result).not.toContain('**Description:**');
    expect(result).not.toContain('**Current Step:**');
  });

  it('formats a goal reference', () => {
    const result = buildReferenceContext({ '@ref{goal:goal-uuid-1}': goalRef });
    expect(result).toContain('### Goal: g-1');
    expect(result).toContain('**Title:** Launch v2');
    expect(result).toContain('**Type:** measurable');
    expect(result).toContain('**Status:** active');
    expect(result).toContain('**Progress:** 30%');
    expect(result).toContain('**Description:** Release the v2 product');
    expect(result).toContain('**Metrics:**');
    expect(result).toContain('features: 3 / 10');
    expect(result).toContain('coverage: 70 % / 90 %');
  });

  it('uses fallback id when goal has no shortId', () => {
    const ref: ResolvedReference = {
      type: 'goal',
      id: 'goal-uuid-2',
      data: {
        id: 'goal-uuid-2',
        shortId: null,
        title: 'No short id goal',
        status: 'active',
        progress: 0,
        roomId: 'room-1',
      },
    };
    const result = buildReferenceContext({ '@ref{goal:goal-uuid-2}': ref });
    expect(result).toContain('### Goal: goal-uuid-2');
  });

  it('omits optional goal fields when absent', () => {
    const ref: ResolvedReference = {
      type: 'goal',
      id: 'goal-uuid-3',
      data: {
        id: 'goal-uuid-3',
        shortId: 'g-3',
        title: 'Minimal goal',
        status: 'active',
        progress: 0,
        structuredMetrics: [],
        roomId: 'room-1',
      },
    };
    const result = buildReferenceContext({ '@ref{goal:goal-uuid-3}': ref });
    expect(result).not.toContain('**Type:**');
    expect(result).not.toContain('**Description:**');
    expect(result).not.toContain('**Metrics:**');
  });

  it('formats a file reference with content', () => {
    const result = buildReferenceContext({ '@ref{file:src/lib/utils.ts}': fileRef });
    expect(result).toContain('### File: src/lib/utils.ts');
    expect(result).toContain('```');
    expect(result).toContain('export function add');
  });

  it('marks truncated file content', () => {
    const result = buildReferenceContext({ '@ref{file:src/large.ts}': truncatedFileRef });
    expect(result).toContain('``` (truncated)');
  });

  it('shows binary marker for binary files', () => {
    const result = buildReferenceContext({ '@ref{file:assets/logo.png}': binaryFileRef });
    expect(result).toContain('### File: assets/logo.png');
    expect(result).toContain('[binary file — content not shown]');
  });

  it('shows unavailable marker when content is null (non-binary)', () => {
    const result = buildReferenceContext({ '@ref{file:src/missing.ts}': nullContentFileRef });
    expect(result).toContain('[content unavailable]');
  });

  it('formats a folder reference with entries', () => {
    const result = buildReferenceContext({ '@ref{folder:src/lib}': folderRef });
    expect(result).toContain('### Folder: src/lib');
    expect(result).toContain('- utils.ts');
    expect(result).toContain('- components/');
  });

  it('shows empty folder marker for empty folder', () => {
    const result = buildReferenceContext({ '@ref{folder:src/empty}': emptyFolderRef });
    expect(result).toContain('[empty folder]');
  });

  it('wraps sections in ## Referenced Entities header', () => {
    const result = buildReferenceContext({ '@ref{file:src/lib/utils.ts}': fileRef });
    expect(result).toMatch(/^## Referenced Entities\n\n/);
  });

  it('returns empty string when all references produce no output (unknown type)', () => {
    const unknownRef = { type: 'unknown' as ResolvedReference['type'], id: 'x', data: null };
    const result = buildReferenceContext({ '@ref{unknown:x}': unknownRef as ResolvedReference });
    expect(result).toBe('');
  });

  it('sorts by priority: task > goal > file > folder', () => {
    const refs = {
      '@ref{folder:src/lib}': folderRef,
      '@ref{file:src/lib/utils.ts}': fileRef,
      '@ref{goal:goal-uuid-1}': goalRef,
      '@ref{task:task-uuid-1}': taskRef,
    };
    const result = buildReferenceContext(refs);
    const taskPos = result.indexOf('### Task:');
    const goalPos = result.indexOf('### Goal:');
    const filePos = result.indexOf('### File:');
    const folderPos = result.indexOf('### Folder:');
    expect(taskPos).toBeLessThan(goalPos);
    expect(goalPos).toBeLessThan(filePos);
    expect(filePos).toBeLessThan(folderPos);
  });

  it('handles unknown type references by placing them after folder', () => {
    const unknownRef = { type: 'metric' as ResolvedReference['type'], id: 'x', data: {} };
    const refs = {
      '@ref{folder:src/lib}': folderRef,
      '@ref{metric:x}': unknownRef as ResolvedReference,
      '@ref{task:task-uuid-1}': taskRef,
    };
    const result = buildReferenceContext(refs);
    expect(result).toContain('### Task:');
    expect(result).toContain('### Folder:');
  });

  it('truncates when total bytes exceed MAX_CONTEXT_BYTES', () => {
    const largeContent = 'x'.repeat(MAX_CONTEXT_BYTES - 40);
    const largeFileRef: ResolvedReference = {
      type: 'file',
      id: 'src/huge.ts',
      data: { path: 'src/huge.ts', content: largeContent, binary: false, truncated: false },
    };
    const smallFileRef: ResolvedReference = {
      type: 'file',
      id: 'src/small.ts',
      data: {
        path: 'src/small.ts',
        content: 'tiny content',
        binary: false,
        truncated: false,
      },
    };
    const result = buildReferenceContext({
      '@ref{file:src/huge.ts}': largeFileRef,
      '@ref{file:src/small.ts}': smallFileRef,
    });
    expect(result).toContain('src/huge.ts');
    expect(result).not.toContain('src/small.ts');
  });

  it('includes multiple references when within size limit', () => {
    const result = buildReferenceContext({
      '@ref{task:task-uuid-1}': taskRef,
      '@ref{file:src/lib/utils.ts}': fileRef,
    });
    expect(result).toContain('### Task:');
    expect(result).toContain('### File:');
  });

  it('returns empty string if the single reference exceeds the limit', () => {
    const hugeContent = 'x'.repeat(MAX_CONTEXT_BYTES + 1000);
    const hugeRef: ResolvedReference = {
      type: 'file',
      id: 'src/enormous.ts',
      data: { path: 'src/enormous.ts', content: hugeContent, binary: false, truncated: false },
    };
    const result = buildReferenceContext({ '@ref{file:src/enormous.ts}': hugeRef });
    expect(result).toBe('');
  });

  it('metric without unit shows value without unit suffix', () => {
    const ref: ResolvedReference = {
      type: 'goal',
      id: 'goal-uuid-4',
      data: {
        id: 'goal-uuid-4',
        shortId: 'g-4',
        title: 'Count goal',
        status: 'active',
        progress: 0,
        structuredMetrics: [{ name: 'items', current: 5, target: 20 }],
        roomId: 'room-1',
      },
    };
    const result = buildReferenceContext({ '@ref{goal:goal-uuid-4}': ref });
    expect(result).toContain('items: 5 / 20');
    expect(result).not.toContain('undefined');
  });
});

describe('prependContextToMessage', () => {
  it('returns original message unchanged when context is empty string', () => {
    const msg = 'Please fix the bug';
    expect(prependContextToMessage(msg, '')).toBe(msg);
  });

  it('prepends context with separator when context is non-empty', () => {
    const msg = 'Please fix the bug';
    const ctx = '## Referenced Entities\n\n### Task: t-1\n**Title:** Fix login bug\n';
    const result = prependContextToMessage(msg, ctx);
    expect(result).toBe(`${ctx}\n\n---\n\n${msg}`);
  });

  it('preserves original message content exactly', () => {
    const msg = 'Multi\nline\nmessage with **markdown**';
    const ctx = '## Referenced Entities\n\n### File: utils.ts\n```\ncode\n```\n';
    const result = prependContextToMessage(msg, ctx);
    expect(result.endsWith(msg)).toBe(true);
  });

  it('handles empty user message with non-empty context', () => {
    const ctx = '## Referenced Entities\n\n### Task: t-1\n**Title:** Test\n';
    const result = prependContextToMessage('', ctx);
    expect(result).toBe(`${ctx}\n\n---\n\n`);
  });
});
