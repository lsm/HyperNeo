/**
 * ArtifactCard — data-driven renderer tests.
 *
 * Verifies that the correct renderer is selected based on the shape of
 * artifact.data, NOT the artifactType string.  Also checks that artifactType
 * always appears as a badge regardless of which renderer is active.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { ArtifactCard } from '../ArtifactCard';
import type { WorkflowRunArtifact } from '@hyperneo/shared';

function makeArtifact(
  overrides: Partial<WorkflowRunArtifact> & { data: Record<string, unknown> }
): WorkflowRunArtifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    nodeId: 'node-1',
    artifactType: 'result',
    artifactKey: 'key',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ── PR card ──────────────────────────────────────────────────────────────────

describe('ArtifactCard — PR renderer', () => {
  it('renders artifact-card-pr when data.url is a GitHub PR URL', () => {
    const artifact = makeArtifact({
      data: { url: 'https://github.com/owner/repo/pull/42', number: 42, title: 'My PR' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-pr')).toBeTruthy();
  });

  it('shows PR number and title from data fields', () => {
    const artifact = makeArtifact({
      data: { url: 'https://github.com/owner/repo/pull/7', number: 7, title: 'Fix bug' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-pr');
    expect(card.textContent).toContain('PR #7');
    expect(card.textContent).toContain('Fix bug');
  });

  it('shows state badge when data.state is provided', () => {
    const artifact = makeArtifact({
      data: { url: 'https://github.com/owner/repo/pull/1', state: 'merged' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-pr').textContent).toContain('merged');
  });

  it('shows artifactType badge on the PR card', () => {
    const artifact = makeArtifact({
      artifactType: 'pr',
      data: { url: 'https://github.com/owner/repo/pull/1' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-pr').textContent).toContain('pr');
  });
});

// ── Commit reference card ─────────────────────────────────────────────────────

describe('ArtifactCard — commit-ref renderer', () => {
  it('renders artifact-card-commit-ref when data.url is a GitHub commit URL', () => {
    const artifact = makeArtifact({
      data: { url: 'https://github.com/owner/repo/commit/abc1234def5678' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-commit-ref')).toBeTruthy();
  });

  it('shows short SHA from the URL', () => {
    const artifact = makeArtifact({
      data: { url: 'https://github.com/owner/repo/commit/abc1234def5678' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-commit-ref').textContent).toContain('abc1234');
  });

  it('shows commit message and author when provided in data', () => {
    const artifact = makeArtifact({
      data: {
        url: 'https://github.com/owner/repo/commit/abc1234def5678',
        message: 'feat: do thing',
        author: 'Alice',
      },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-commit-ref');
    expect(card.textContent).toContain('feat: do thing');
    expect(card.textContent).toContain('Alice');
  });

  it('does NOT use commit-ref renderer for GitHub PR URLs (PR wins)', () => {
    const artifact = makeArtifact({
      data: { url: 'https://github.com/owner/repo/pull/99' },
    });
    const { getByTestId, queryByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-pr')).toBeTruthy();
    expect(queryByTestId('artifact-card-commit-ref')).toBeNull();
  });
});

// ── Link card ─────────────────────────────────────────────────────────────────

describe('ArtifactCard — link renderer', () => {
  it('renders artifact-card-link for a non-GitHub URL', () => {
    const artifact = makeArtifact({
      data: { url: 'https://example.com/report' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link')).toBeTruthy();
  });

  it('shows custom title when provided', () => {
    const artifact = makeArtifact({
      data: { url: 'https://example.com/report', title: 'Full report' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('Full report');
  });

  it('falls back to URL as title when title is absent', () => {
    const artifact = makeArtifact({
      data: { url: 'https://example.com/no-title' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('example.com');
  });

  it('shows hostname in the card', () => {
    const artifact = makeArtifact({
      data: { url: 'https://docs.example.com/api' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('docs.example.com');
  });
});

// ── Terminal output card ──────────────────────────────────────────────────────

describe('ArtifactCard — terminal renderer', () => {
  it('renders artifact-card-terminal when data.stdout is present', () => {
    const artifact = makeArtifact({
      data: { stdout: 'hello world\n' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-terminal')).toBeTruthy();
  });

  it('renders artifact-card-terminal when data.stderr is present', () => {
    const artifact = makeArtifact({
      data: { stderr: 'error: something failed\n' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-terminal')).toBeTruthy();
  });

  it('renders artifact-card-terminal when data.test_output is present', () => {
    const artifact = makeArtifact({
      data: { test_output: 'PASS src/foo.test.ts\n' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-terminal')).toBeTruthy();
  });

  it('shows first 5 lines of output as preview', () => {
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'];
    const artifact = makeArtifact({
      data: { stdout: lines.join('\n') },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-terminal');
    expect(card.textContent).toContain('line1');
    expect(card.textContent).toContain('line5');
    // line6 is cut off; the truncation indicator appears
    expect(card.textContent).toContain('…');
  });
});

// ── Markdown card ─────────────────────────────────────────────────────────────

describe('ArtifactCard — markdown renderer', () => {
  it('renders artifact-card-markdown when data only has a summary string key', () => {
    const artifact = makeArtifact({
      data: { summary: 'This PR implements feature X, Y, Z.' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-markdown')).toBeTruthy();
  });

  it('shows the summary text', () => {
    const artifact = makeArtifact({
      data: { summary: 'Deployment succeeded on prod.' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-markdown').textContent).toContain(
      'Deployment succeeded on prod.'
    );
  });

  it('does NOT use markdown renderer when summary is one of several keys', () => {
    // summary + another key → table renderer (all primitives)
    const artifact = makeArtifact({
      data: { summary: 'text', status: 'ok' },
    });
    const { getByTestId, queryByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(queryByTestId('artifact-card-markdown')).toBeNull();
    expect(getByTestId('artifact-card-table')).toBeTruthy();
  });
});

// ── Structured table card ─────────────────────────────────────────────────────

describe('ArtifactCard — table renderer', () => {
  it('renders artifact-card-table when data has flat primitive key-value pairs', () => {
    const artifact = makeArtifact({
      data: { status: 'ok', count: 42, flag: true },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-table')).toBeTruthy();
  });

  it('shows all key-value pairs in the table', () => {
    const artifact = makeArtifact({
      data: { environment: 'production', version: '1.2.3' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-table');
    expect(card.textContent).toContain('environment');
    expect(card.textContent).toContain('production');
    expect(card.textContent).toContain('version');
    expect(card.textContent).toContain('1.2.3');
  });

  it('renders boolean values', () => {
    const artifact = makeArtifact({
      data: { success: true, failed: false },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-table');
    expect(card.textContent).toContain('true');
    expect(card.textContent).toContain('false');
  });

  it('shows null values as "null"', () => {
    const artifact = makeArtifact({
      data: { missing: null },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-table').textContent).toContain('null');
  });

  it('does NOT use table renderer when data has nested objects', () => {
    const artifact = makeArtifact({
      data: { nested: { key: 'value' } },
    });
    const { getByTestId, queryByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(queryByTestId('artifact-card-table')).toBeNull();
    // Falls through to generic
    expect(getByTestId('artifact-card-generic')).toBeTruthy();
  });
});

// ── Generic fallback ──────────────────────────────────────────────────────────

describe('ArtifactCard — generic renderer', () => {
  it('renders artifact-card-generic for unrecognised data shapes', () => {
    const artifact = makeArtifact({
      data: { nested: { deep: 'value' }, arr: [1, 2, 3] },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-generic')).toBeTruthy();
  });

  it('shows artifactType badge on the generic card', () => {
    const artifact = makeArtifact({
      artifactType: 'custom_event',
      data: { nested: { x: 1 } },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-generic').textContent).toContain('custom_event');
  });
});

// ── Type badge visible on all renderers ──────────────────────────────────────

describe('ArtifactCard — type badge always visible', () => {
  const cases: Array<{ desc: string; data: Record<string, unknown>; testId: string }> = [
    {
      desc: 'PR renderer',
      data: { url: 'https://github.com/o/r/pull/1' },
      testId: 'artifact-card-pr',
    },
    {
      desc: 'commit-ref renderer',
      data: { url: 'https://github.com/o/r/commit/abc1234' },
      testId: 'artifact-card-commit-ref',
    },
    {
      desc: 'link renderer',
      data: { url: 'https://example.com' },
      testId: 'artifact-card-link',
    },
    {
      desc: 'terminal renderer',
      data: { stdout: 'output' },
      testId: 'artifact-card-terminal',
    },
    { desc: 'markdown renderer', data: { summary: 'text' }, testId: 'artifact-card-markdown' },
    { desc: 'table renderer', data: { k: 'v' }, testId: 'artifact-card-table' },
  ];

  for (const { desc, data, testId } of cases) {
    it(`shows artifactType badge on the ${desc}`, () => {
      const artifact = makeArtifact({ artifactType: 'my_type', data });
      const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
      expect(getByTestId(testId).textContent).toContain('my_type');
    });
  }
});
