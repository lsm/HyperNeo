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
    artifactType: 'note',
    artifactKey: 'key',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ArtifactCard — link shape', () => {
  it('renders artifact-card-link for the link shape', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://example.com/report', title: 'Full report' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link')).toBeTruthy();
  });

  it('renders a PR row when kind is "pr" — no GitHub URL detection involved', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: {
        url: 'https://gitlab.internal/o/r/-/merge_requests/42',
        kind: 'pr',
        number: 42,
        title: 'Fix bug',
      },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-link');
    expect(card.textContent).toContain('Pull Request #42');
    expect(card.textContent).toContain('Fix bug');
  });

  it('shows PR state badge from data.state', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://github.com/o/r/pull/7', kind: 'pr', state: 'merged' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('merged');
  });

  it('labels an issue by kind', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://github.com/o/r/issues/9', kind: 'issue', number: 9 },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('Issue #9');
  });

  it('shows hostname for a plain link without a title', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://docs.example.com/api' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('docs.example.com');
  });

  it('uses the title as the link label when present', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://example.com/x', title: 'Custom title' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('Custom title');
  });

  it('does NOT special-case github.com pull URLs without kind:"pr" — renders as a plain link', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://github.com/owner/repo/pull/42' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-link');
    expect(card.textContent).not.toContain('Pull Request');
  });

  it('renders an http(s) URL as a clickable anchor', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://example.com/safe', title: 'safe' },
    });
    const { container } = render(<ArtifactCard artifact={artifact} />);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com/safe');
  });

  it('renders a non-http URL as plain text, never as an actionable anchor (XSS guard)', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'javascript:alert(1)', title: 'evil' },
    });
    const { container, getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(container.querySelector('a')).toBeNull();
    expect(getByTestId('artifact-card-link').textContent).toContain('evil');
  });

  it('shows the URL for a minimal PR link with no number or title (keeps rows distinguishable)', () => {
    const artifact = makeArtifact({
      artifactType: 'link',
      data: { url: 'https://gitlab.internal/o/r/-/merge_requests/5', kind: 'pr' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('gitlab.internal');
  });
});

describe('ArtifactCard — commit_set shape', () => {
  it('renders artifact-card-commit-set with the commit count and +/- totals', () => {
    const artifact = makeArtifact({
      artifactType: 'commit_set',
      data: {
        branch: 'feat/x',
        head: 'abcdef1234567890',
        additions: 120,
        deletions: 30,
        commits: [
          { sha: 'abcdef1234567890', message: 'feat: add thing' },
          { sha: '9876543210fedcba', message: 'fix: tweak' },
        ],
      },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-commit-set');
    expect(card.textContent).toContain('2 commits');
    expect(card.textContent).toContain('+120');
    expect(card.textContent).toContain('-30');
    expect(card.textContent).toContain('feat/x');
    expect(card.textContent).toContain('feat: add thing');
    expect(card.textContent).toContain('abcdef1');
  });

  it('collapses commit lists longer than five entries', () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({
      sha: `sha${i}000000000000000`,
      message: `commit ${i}`,
    }));
    const artifact = makeArtifact({ artifactType: 'commit_set', data: { commits } });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-commit-set');
    expect(card.textContent).toContain('+2 more');
  });

  it('ignores null / non-object commit entries instead of throwing', () => {
    const commits = [
      null,
      { sha: 'abcdef1234567890', message: 'the only real commit' },
      42,
      undefined,
    ];
    const artifact = makeArtifact({ artifactType: 'commit_set', data: { commits } });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-commit-set');
    expect(card.textContent).toContain('1 commit');
    expect(card.textContent).toContain('the only real commit');
  });
});

describe('ArtifactCard — check shape', () => {
  it('renders artifact-card-check with the status chip, name and counts', () => {
    const artifact = makeArtifact({
      artifactType: 'check',
      data: { name: 'unit-tests', status: 'pass', counts: { passed: 40, failed: 1, skipped: 3 } },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-check');
    expect(card.textContent).toContain('pass');
    expect(card.textContent).toContain('unit-tests');
    expect(card.textContent).toContain('40 passed');
    expect(card.textContent).toContain('1 failed');
    expect(card.textContent).toContain('3 skipped');
  });

  it('renders a fail status chip', () => {
    const artifact = makeArtifact({
      artifactType: 'check',
      data: { name: 'ci', status: 'fail' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-check').textContent).toContain('fail');
  });
});

describe('ArtifactCard — metric shape', () => {
  it('renders artifact-card-metric with name, value, unit and target', () => {
    const artifact = makeArtifact({
      artifactType: 'metric',
      data: { name: 'p95-latency', value: 42, unit: 'ms', target: 50 },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-metric');
    expect(card.textContent).toContain('p95-latency');
    expect(card.textContent).toContain('42');
    expect(card.textContent).toContain('ms');
    expect(card.textContent).toContain('50');
  });

  it('does not stringify a non-scalar value to "[object Object]"', () => {
    const artifact = makeArtifact({
      artifactType: 'metric',
      data: { name: 'latency', value: { current: 42 } },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-metric');
    expect(card.textContent).toContain('latency');
    expect(card.textContent).not.toContain('[object Object]');
  });
});

describe('ArtifactCard — decision shape', () => {
  it('renders artifact-card-decision with the recommendation badge and summary', () => {
    const artifact = makeArtifact({
      artifactType: 'decision',
      data: { recommendation: 'approve', summary: 'LGTM', counts: { p0: 0, p1: 2 } },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-decision');
    expect(card.textContent).toContain('approve');
    expect(card.textContent).toContain('LGTM');
    expect(card.textContent).toContain('2 p1');
  });

  it('renders a request_changes recommendation', () => {
    const artifact = makeArtifact({
      artifactType: 'decision',
      data: { recommendation: 'request_changes' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-decision').textContent).toContain('request_changes');
  });

  it('surfaces the review evidence link for legacy review rows mapped to decision', () => {
    const artifact = makeArtifact({
      artifactType: 'decision',
      data: { review_url: 'https://github.com/o/r/pull/1#review', cycle: 0 },
    });
    const { container, getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://github.com/o/r/pull/1#review');
    expect(getByTestId('artifact-card-decision').textContent).toContain('review');
  });

  it('falls back to review_url when data.url is a non-http scheme (link is not dropped)', () => {
    const artifact = makeArtifact({
      artifactType: 'decision',
      data: { url: 'ftp://example.com/x', review_url: 'https://github.com/o/r/pull/1#review' },
    });
    const { container } = render(<ArtifactCard artifact={artifact} />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/1#review'
    );
  });

  it('labels the link by the actually-selected URL (data.url wins over review_url)', () => {
    const artifact = makeArtifact({
      artifactType: 'decision',
      data: { url: 'https://example.com/a', review_url: 'https://example.com/b' },
    });
    const { container, getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a');
    expect(getByTestId('artifact-card-decision').textContent).toContain('view');
    expect(getByTestId('artifact-card-decision').textContent).not.toContain('review');
  });
});

describe('ArtifactCard — note shape', () => {
  it('renders artifact-card-note with the text', () => {
    const artifact = makeArtifact({
      artifactType: 'note',
      data: { text: 'Running the test suite now.' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-note').textContent).toContain('Running the test suite now.');
  });

  it('falls back to data.summary when data.text is absent (legacy compat)', () => {
    const artifact = makeArtifact({
      artifactType: 'note',
      data: { summary: 'Legacy status line.' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-note').textContent).toContain('Legacy status line.');
  });
});

describe('ArtifactCard — default renderer', () => {
  it('renders artifact-card-generic for an unknown shape', () => {
    const artifact = makeArtifact({
      artifactType: 'something_new',
      data: { any: 'value', nested: { x: 1 } },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-generic');
    expect(card.textContent).toContain('something_new');
  });

  it('default renderer works for an empty data payload', () => {
    const artifact = makeArtifact({ artifactType: 'something_new', data: {} });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-generic')).toBeTruthy();
  });
});

describe('ArtifactCard — legacy type normalization', () => {
  it('renders a legacy "pr" artifact as a link row', () => {
    const artifact = makeArtifact({
      artifactType: 'pr',
      data: { pr_url: 'https://github.com/o/r/pull/5', number: 5, kind: 'pr' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('Pull Request #5');
  });

  it('renders a legacy "progress" artifact as a note line', () => {
    const artifact = makeArtifact({
      artifactType: 'progress',
      data: { summary: 'Running the test suite.' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-note').textContent).toContain('Running the test suite.');
  });

  it('renders a legacy "result" artifact without a URL as a decision', () => {
    const artifact = makeArtifact({
      artifactType: 'result',
      data: { summary: 'Shipped to production.' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-decision').textContent).toContain('Shipped to production.');
  });

  it('renders a mixed QA "result" (pr_url + summary) as a decision, preserving the summary', () => {
    const artifact = makeArtifact({
      artifactType: 'result',
      data: {
        summary: 'QA passed: backend + browser golden path exercised.',
        pr_url: 'https://github.com/o/r/pull/9',
        test_output: 'all green',
        ui_changed: true,
      },
    });
    const { container, getByTestId } = render(<ArtifactCard artifact={artifact} />);
    const card = getByTestId('artifact-card-decision');
    expect(card.textContent).toContain('QA passed');
    expect(card.textContent).not.toContain('Pull Request');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/9'
    );
  });

  it('renders a legacy "result" artifact carrying pr_url as a link', () => {
    const artifact = makeArtifact({
      artifactType: 'result',
      data: { pr_url: 'https://github.com/o/r/pull/9', kind: 'pr', number: 9 },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link').textContent).toContain('Pull Request #9');
  });

  it('renders a legacy merge-audit "result" (merged_pr_url) as a link, not an empty card', () => {
    const artifact = makeArtifact({
      artifactType: 'result',
      data: {
        merged_pr_url: 'https://github.com/o/r/pull/42',
        merged_at: '2026-08-02T00:00:00Z',
        approval_source: 'human',
      },
    });
    const { container, getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-link')).toBeTruthy();
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/42'
    );
  });

  it('renders a legacy "review" artifact as a decision with the review link', () => {
    const artifact = makeArtifact({
      artifactType: 'review',
      data: { review_url: 'https://github.com/o/r/pull/1#review', cycle: 0 },
    });
    const { container, getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-decision')).toBeTruthy();
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/1#review'
    );
  });

  it('falls through to the default renderer for a truly unknown legacy type', () => {
    const artifact = makeArtifact({
      artifactType: 'mystery_type',
      data: { foo: 'bar' },
    });
    const { getByTestId } = render(<ArtifactCard artifact={artifact} />);
    expect(getByTestId('artifact-card-generic')).toBeTruthy();
  });
});
