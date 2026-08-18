// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/preact';
import { parseDiff } from '../FileDiffView';

const mockRequest: Mock = vi.fn();
const mockHub = { request: mockRequest };

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { FileDiffView } from '../FileDiffView';

describe('parseDiff', () => {
  it('returns empty array for empty string', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('parses diff --git header', () => {
    const lines = parseDiff('diff --git a/foo.ts b/foo.ts');
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('header');
    expect(lines[0].oldLineNum).toBeNull();
    expect(lines[0].newLineNum).toBeNull();
  });

  it('parses index line', () => {
    const lines = parseDiff('index abc123..def456 100644');
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('index');
  });

  it('parses file-header lines (--- and +++)', () => {
    const diff = '--- a/foo.ts\n+++ b/foo.ts';
    const lines = parseDiff(diff);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('file-header');
    expect(lines[1].type).toBe('file-header');
  });

  it('resets line counters on hunk header', () => {
    const diff = '@@ -5,3 +10,3 @@ function foo() {\n -old\n +new\n  ctx';
    const lines = parseDiff(diff);
    const hunk = lines.find((l) => l.type === 'hunk');
    expect(hunk).toBeDefined();
    expect(hunk!.oldLineNum).toBeNull();
    expect(hunk!.newLineNum).toBeNull();
  });

  it('increments new line number for additions', () => {
    const diff = '@@ -1,1 +1,2 @@\n+added line\n+another';
    const lines = parseDiff(diff).filter((l) => l.type === 'added');
    expect(lines[0].newLineNum).toBe(1);
    expect(lines[1].newLineNum).toBe(2);
    expect(lines[0].oldLineNum).toBeNull();
  });

  it('increments old line number for removals', () => {
    const diff = '@@ -3,2 +3,1 @@\n-removed1\n-removed2';
    const lines = parseDiff(diff).filter((l) => l.type === 'removed');
    expect(lines[0].oldLineNum).toBe(3);
    expect(lines[1].oldLineNum).toBe(4);
    expect(lines[0].newLineNum).toBeNull();
  });

  it('increments both counters for context lines', () => {
    const diff = '@@ -2,1 +2,1 @@\n context';
    const lines = parseDiff(diff).filter((l) => l.type === 'context');
    expect(lines[0].oldLineNum).toBe(2);
    expect(lines[0].newLineNum).toBe(2);
  });

  it('trailing newline does not produce a phantom context line', () => {
    const diff = '@@ -1,1 +1,1 @@\n-old\n+new\n';
    const lines = parseDiff(diff);
    expect(lines.length).toBe(3);
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'removed', 'added']);
  });

  it('does not increment counters for "no newline at end of file" line', () => {
    const diff =
      '@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file';
    const lines = parseDiff(diff);
    const noNewline = lines.filter((l) => l.content.startsWith('\\ No newline'));
    expect(noNewline.length).toBe(2);
    noNewline.forEach((l) => {
      expect(l.oldLineNum).toBeNull();
      expect(l.newLineNum).toBeNull();
    });
    const removed = lines.find((l) => l.type === 'removed');
    const added = lines.find((l) => l.type === 'added');
    expect(removed!.oldLineNum).toBe(1);
    expect(added!.newLineNum).toBe(1);
  });

  it('treats rename/similarity lines as index (no counter increment)', () => {
    const diff =
      'diff --git a/a.ts b/b.ts\nsimilarity index 95%\nrename from a.ts\nrename to b.ts\n--- a/a.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-old\n+new';
    const lines = parseDiff(diff);
    const renameLines = lines.filter(
      (l) => l.content.startsWith('similarity') || l.content.startsWith('rename')
    );
    expect(renameLines.length).toBe(3);
    renameLines.forEach((l) => expect(l.type).toBe('index'));
    const removed = lines.find((l) => l.type === 'removed');
    const added = lines.find((l) => l.type === 'added');
    expect(removed!.oldLineNum).toBe(1);
    expect(added!.newLineNum).toBe(1);
  });

  it('strips leading sigil from addition content', () => {
    const diff = '@@ -1,1 +1,1 @@\n+const x = 1;';
    const lines = parseDiff(diff).filter((l) => l.type === 'added');
    expect(lines[0].content).toBe('const x = 1;');
  });

  it('strips leading sigil from removal content', () => {
    const diff = '@@ -1,1 +1,1 @@\n-const x = 0;';
    const lines = parseDiff(diff).filter((l) => l.type === 'removed');
    expect(lines[0].content).toBe('const x = 0;');
  });
});

describe('FileDiffView', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading spinner while fetching', async () => {
    mockRequest.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(
      <FileDiffView runId="run-1" filePath="src/foo.ts" onBack={vi.fn()} />
    );
    expect(getByTestId('diff-loading')).toBeDefined();
  });

  it('shows error when hub not connected', async () => {
    const { connectionManager } = await import('../../../lib/connection-manager');
    (connectionManager.getHubIfConnected as Mock).mockReturnValueOnce(null);

    const { getByTestId } = render(
      <FileDiffView runId="run-1" filePath="src/foo.ts" onBack={vi.fn()} />
    );
    await waitFor(() => expect(getByTestId('diff-error')).toBeDefined());
  });

  it('shows error when RPC fails', async () => {
    mockRequest.mockRejectedValue(new Error('git error'));
    const { getByTestId } = render(
      <FileDiffView runId="run-1" filePath="src/foo.ts" onBack={vi.fn()} />
    );
    await waitFor(() => {
      const el = getByTestId('diff-error');
      expect(el.textContent).toContain('git error');
    });
  });

  it('renders diff table when RPC succeeds', async () => {
    const sampleDiff =
      'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-old\n+new';
    mockRequest.mockResolvedValue({
      diff: sampleDiff,
      additions: 1,
      deletions: 1,
      filePath: 'f.ts',
    });
    const { getByTestId } = render(<FileDiffView runId="run-1" filePath="f.ts" onBack={vi.fn()} />);
    await waitFor(() => expect(getByTestId('diff-table')).toBeDefined());
  });

  it('shows additions and deletions counts', async () => {
    mockRequest.mockResolvedValue({
      diff: '@@ -1,1 +1,1 @@\n-old\n+new',
      additions: 5,
      deletions: 3,
      filePath: 'f.ts',
    });
    const { getByTestId } = render(<FileDiffView runId="run-1" filePath="f.ts" onBack={vi.fn()} />);
    await waitFor(() => {
      expect(getByTestId('diff-additions').textContent).toBe('+5');
      expect(getByTestId('diff-deletions').textContent).toBe('-3');
    });
  });

  it('calls onBack when back button is clicked', async () => {
    mockRequest.mockResolvedValue({ diff: '', additions: 0, deletions: 0, filePath: 'f.ts' });
    const onBack = vi.fn();
    const { getByTestId } = render(<FileDiffView runId="run-1" filePath="f.ts" onBack={onBack} />);
    await waitFor(() => expect(getByTestId('diff-empty')).toBeDefined());
    fireEvent.click(getByTestId('file-diff-back'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('shows no-changes message for empty diff', async () => {
    mockRequest.mockResolvedValue({ diff: '', additions: 0, deletions: 0, filePath: 'f.ts' });
    const { getByTestId } = render(<FileDiffView runId="run-1" filePath="f.ts" onBack={vi.fn()} />);
    await waitFor(() => expect(getByTestId('diff-empty')).toBeDefined());
  });

  it('sends correct RPC params', async () => {
    mockRequest.mockResolvedValue({ diff: '', additions: 0, deletions: 0, filePath: 'src/bar.ts' });
    render(<FileDiffView runId="run-42" filePath="src/bar.ts" onBack={vi.fn()} />);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledOnce());
    expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.getFileDiff', {
      runId: 'run-42',
      filePath: 'src/bar.ts',
    });
  });
});
