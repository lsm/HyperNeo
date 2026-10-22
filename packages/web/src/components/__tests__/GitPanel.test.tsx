import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type {
  GitFileDiffResponse,
  GitSessionStatusResponse,
  GitReviewFile,
} from '@hyperneo/shared';

vi.mock('../../hooks/useGitSessionStatus', () => ({
  useGitSessionStatus: vi.fn(),
}));

vi.mock('../../lib/api-helpers', () => ({
  getGitFileDiff: vi.fn(),
}));

import { GitPanel } from '../GitPanel.tsx';
import { useGitSessionStatus } from '../../hooks/useGitSessionStatus.ts';
import { getGitFileDiff } from '../../lib/api-helpers.ts';

const mockedUseGitSessionStatus = vi.mocked(useGitSessionStatus);
const mockedGetGitFileDiff = vi.mocked(getGitFileDiff);

function makeFile(overrides: Partial<GitReviewFile>): GitReviewFile {
  return {
    path: 'src/foo.ts',
    oldPath: undefined,
    status: 'modified',
    additions: 5,
    deletions: 1,
    patch: '+added\n context\n-removed',
    patchTruncated: false,
    source: 'working_tree',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<GitSessionStatusResponse> = {}): GitSessionStatusResponse {
  return {
    sessionId: 'session-1',
    mode: 'direct',
    isGitRepo: true,
    workspacePath: '/repo',
    worktreePath: null,
    mainRepoPath: '/repo',
    gitRoot: '/repo',
    branch: 'main',
    baseBranch: 'main',
    defaultBranch: 'main',
    isDirty: true,
    files: [],
    commitsAhead: [],
    aheadCount: 0,
    behindCount: 0,
    review: {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      pullRequest: null,
      checks: [],
    },
    ...overrides,
  };
}

function setStatus(
  status: GitSessionStatusResponse | null,
  overrides: Partial<{
    loading: boolean;
    error: string | null;
  }> = {}
) {
  mockedUseGitSessionStatus.mockReturnValue({
    status,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    refresh: vi.fn(),
  });
}

function renderPanel() {
  return render(<GitPanel sessionId="session-1" />);
}

describe('GitPanel', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    mockedGetGitFileDiff.mockReset();
    setStatus(makeStatus());
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the loading skeleton before the first status resolves', () => {
    setStatus(null, { loading: true });
    const { container } = renderPanel();
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders an error empty state when the status fetch fails', () => {
    setStatus(null, { error: 'boom' });
    const { container } = renderPanel();
    expect(container.textContent).toContain('Git status unavailable');
    expect(container.textContent).toContain('boom');
  });

  it('shows the no-workspace empty state for mode "none"', () => {
    setStatus(makeStatus({ mode: 'none', isGitRepo: false }));
    const { container } = renderPanel();
    expect(container.textContent).toContain('No Git workspace');
  });

  it('shows the not-a-repo empty state when isGitRepo is false', () => {
    setStatus(makeStatus({ isGitRepo: false }));
    const { container } = renderPanel();
    expect(container.textContent).toContain('Not a Git repository');
  });

  it('renders ahead/behind counts in the summary', () => {
    setStatus(makeStatus({ aheadCount: 3, behindCount: 1 }));
    const { container } = renderPanel();
    expect(container.textContent).toContain('3 ahead · 1 behind');
  });

  it('hides the ahead/behind row when aheadCount is null', () => {
    setStatus(makeStatus({ aheadCount: null, behindCount: null }));
    const { container } = renderPanel();
    expect(container.textContent).not.toMatch(/\d+ ahead/);
  });

  describe('checks drill-down', () => {
    it('lists individual checks with links to their CI runs', () => {
      setStatus(
        makeStatus({
          review: {
            files: [],
            totalAdditions: 0,
            totalDeletions: 0,
            pullRequest: null,
            checks: [
              {
                name: 'build',
                state: 'completed',
                bucket: 'pass',
                url: 'https://ci.example.com/build',
              },
              { name: 'lint', state: 'failure', bucket: 'fail', url: null },
            ],
          },
        })
      );
      const { container } = renderPanel();

      fireEvent.click(container.querySelector('[data-testid="git-checks-toggle"]')!);

      const list = container.querySelector('[data-testid="git-checks-list"]')!;
      expect(list).toBeTruthy();
      expect(list.textContent).toContain('build');
      expect(list.textContent).toContain('lint');

      const link = list.querySelector<HTMLAnchorElement>('a[href="https://ci.example.com/build"]');
      expect(link).toBeTruthy();
      expect(list.querySelectorAll('a')).toHaveLength(1);
    });
  });

  describe('file list', () => {
    it('groups files into Staged and Unstaged based on the working-tree flags', () => {
      setStatus(
        makeStatus({
          files: [
            { path: 'src/a.ts', status: 'modified', staged: true, unstaged: false },
            { path: 'src/b.ts', status: 'modified', staged: false, unstaged: true },
          ],
          review: {
            files: [makeFile({ path: 'src/a.ts' }), makeFile({ path: 'src/b.ts' })],
            totalAdditions: 10,
            totalDeletions: 2,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const headers = Array.from(container.querySelectorAll('.sticky')).map((h) => h.textContent);
      expect(headers).toContain('Staged · 1');
      expect(headers).toContain('Unstaged · 1');
    });

    it('places a file with both staged and unstaged changes in both groups', () => {
      setStatus(
        makeStatus({
          files: [{ path: 'src/c.ts', status: 'modified', staged: true, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/c.ts' })],
            totalAdditions: 8,
            totalDeletions: 1,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const headers = Array.from(container.querySelectorAll('.sticky')).map((h) => h.textContent);
      expect(headers).toContain('Staged · 1');
      expect(headers).toContain('Unstaged · 1');
      expect(container.querySelectorAll('[data-testid="git-copy-path"]')).toHaveLength(2);
    });

    it('filters files by the search query', () => {
      setStatus(
        makeStatus({
          files: [
            { path: 'src/foo.ts', status: 'modified', staged: false, unstaged: true },
            { path: 'src/bar.ts', status: 'modified', staged: false, unstaged: true },
          ],
          review: {
            files: [makeFile({ path: 'src/foo.ts' }), makeFile({ path: 'src/bar.ts' })],
            totalAdditions: 10,
            totalDeletions: 2,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const search = container.querySelector<HTMLInputElement>('[data-testid="git-file-search"]')!;
      fireEvent.input(search, { target: { value: 'foo' } });

      const listText = container.querySelector('.overflow-y-auto')!.textContent!;
      expect(listText).toContain('foo.ts');
      expect(listText).not.toContain('bar.ts');
    });

    it('copies a file path to the clipboard', () => {
      setStatus(
        makeStatus({
          files: [{ path: 'src/foo.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/foo.ts' })],
            totalAdditions: 5,
            totalDeletions: 1,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      fireEvent.click(container.querySelector('[data-testid="git-copy-path"]')!);
      expect(writeText).toHaveBeenCalledWith('src/foo.ts');
    });

    it('percent-encodes reserved characters in the editor link', () => {
      setStatus(
        makeStatus({
          gitRoot: '/repo',
          files: [{ path: 'src/a#b.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/a#b.ts' })],
            totalAdditions: 1,
            totalDeletions: 0,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const link = container.querySelector<HTMLAnchorElement>(
        'a[title="Open in editor (VS Code)"]'
      );
      expect(link).toBeTruthy();
      expect(link!.getAttribute('href')).toBe('vscode://file/repo/src/a%23b.ts');
    });

    it('builds editor links from gitRoot, not mainRepoPath, for a linked worktree', () => {
      setStatus(
        makeStatus({
          gitRoot: '/wt/feature',
          mainRepoPath: '/main/repo',
          worktreePath: null,
          files: [{ path: 'src/x.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/x.ts' })],
            totalAdditions: 1,
            totalDeletions: 0,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const link = container.querySelector<HTMLAnchorElement>(
        'a[title="Open in editor (VS Code)"]'
      );
      expect(link!.getAttribute('href')).toBe('vscode://file/wt/feature/src/x.ts');
    });

    it('percent-encodes literal backslashes in POSIX filenames', () => {
      setStatus(
        makeStatus({
          gitRoot: '/repo',
          files: [{ path: 'src/foo\\bar.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/foo\\bar.ts' })],
            totalAdditions: 1,
            totalDeletions: 0,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const link = container.querySelector<HTMLAnchorElement>(
        'a[title="Open in editor (VS Code)"]'
      );
      expect(link!.getAttribute('href')).toBe('vscode://file/repo/src/foo%5Cbar.ts');
    });

    it('treats UNC roots as Windows paths (normalizes backslashes)', () => {
      setStatus(
        makeStatus({
          gitRoot: '\\\\server\\share\\repo',
          files: [{ path: 'src/x.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/x.ts' })],
            totalAdditions: 1,
            totalDeletions: 0,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const link = container.querySelector<HTMLAnchorElement>(
        'a[title="Open in editor (VS Code)"]'
      );
      const href = link!.getAttribute('href')!;
      expect(href).not.toContain('%5C');
      expect(href).toBe('vscode://file//server/share/repo/src/x.ts');
    });

    it('omits the editor link for deleted files', () => {
      setStatus(
        makeStatus({
          gitRoot: '/repo',
          files: [{ path: 'src/gone.ts', status: 'deleted', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/gone.ts', status: 'deleted' })],
            totalAdditions: 0,
            totalDeletions: 5,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      expect(container.querySelector('a[title="Open in editor (VS Code)"]')).toBeNull();
      expect(container.querySelector('[data-testid="git-copy-path"]')).toBeTruthy();
    });
  });

  describe('expand truncated diff', () => {
    it('fetches and shows the full diff when expanded', async () => {
      const fileDiff: GitFileDiffResponse = {
        sessionId: 'session-1',
        path: 'src/big.ts',
        patch: '+first line\n+second full line\n-context\n-trailing',
        truncated: false,
        additions: 100,
        deletions: 3,
      };
      mockedGetGitFileDiff.mockResolvedValue(fileDiff);

      setStatus(
        makeStatus({
          files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [
              makeFile({
                path: 'src/big.ts',
                patch: '+first line',
                patchTruncated: true,
              }),
            ],
            totalAdditions: 100,
            totalDeletions: 3,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      const expand = container.querySelector('[data-testid="git-expand-diff"]')!;
      fireEvent.click(expand);

      await waitFor(() =>
        expect(mockedGetGitFileDiff).toHaveBeenCalledWith('session-1', 'src/big.ts')
      );
      await waitFor(() => expect(container.textContent).toContain('second full line'));
    });

    it('surfaces a resolved file-diff error and keeps the truncated preview', async () => {
      mockedGetGitFileDiff.mockResolvedValue({
        sessionId: 'session-1',
        path: 'src/big.ts',
        patch: null,
        truncated: false,
        additions: 0,
        deletions: 0,
        error: 'Not a git repository',
      });

      setStatus(
        makeStatus({
          files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
          review: {
            files: [makeFile({ path: 'src/big.ts', patch: '+preview', patchTruncated: true })],
            totalAdditions: 1,
            totalDeletions: 0,
            pullRequest: null,
            checks: [],
          },
        })
      );
      const { container } = renderPanel();

      fireEvent.click(container.querySelector('[data-testid="git-expand-diff"]')!);

      await waitFor(() => expect(container.textContent).toContain('Not a git repository'));
      expect(container.textContent).toContain('+preview');
    });

    it('discards a full-diff response superseded by a refresh', async () => {
      let resolveDiff!: (value: GitFileDiffResponse) => void;
      mockedGetGitFileDiff.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDiff = resolve;
          })
      );

      const status = makeStatus({
        files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
        review: {
          files: [makeFile({ path: 'src/big.ts', patch: '+preview', patchTruncated: true })],
          totalAdditions: 1,
          totalDeletions: 0,
          pullRequest: null,
          checks: [],
        },
      });
      setStatus(status);
      const { container, rerender } = renderPanel();

      fireEvent.click(container.querySelector('[data-testid="git-expand-diff"]')!);
      await waitFor(() => expect(mockedGetGitFileDiff).toHaveBeenCalled());

      const refreshedStatus = makeStatus({
        files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
        review: {
          files: [
            makeFile({ path: 'src/big.ts', patch: '+preview', patchTruncated: true, additions: 9 }),
          ],
          totalAdditions: 9,
          totalDeletions: 0,
          pullRequest: null,
          checks: [],
        },
      });
      mockedUseGitSessionStatus.mockReturnValue({
        status: refreshedStatus,
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      rerender(<GitPanel sessionId="session-1" />);

      await waitFor(() => expect(container.textContent).toContain('+preview'));

      resolveDiff({
        sessionId: 'session-1',
        path: 'src/big.ts',
        patch: '+STALE FULL CONTENT',
        truncated: false,
        additions: 0,
        deletions: 0,
      });
      await waitFor(() => expect(container.textContent).toContain('+preview'));
      expect(container.textContent).not.toContain('STALE FULL CONTENT');
      const button = container.querySelector<HTMLButtonElement>('[data-testid="git-expand-diff"]');
      expect(button?.disabled).toBe(false);
      expect(button?.textContent).not.toContain('Loading');
    });

    it('invalidates the expand when content changes but numstat is unchanged', async () => {
      mockedGetGitFileDiff.mockResolvedValue({
        sessionId: 'session-1',
        path: 'src/big.ts',
        patch: '+FIRST FULL',
        truncated: false,
        additions: 1,
        deletions: 0,
      });

      const status = makeStatus({
        files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
        review: {
          files: [
            makeFile({
              path: 'src/big.ts',
              patch: '+preview one',
              patchTruncated: true,
              additions: 1,
              deletions: 0,
            }),
          ],
          totalAdditions: 1,
          totalDeletions: 0,
          pullRequest: null,
          checks: [],
        },
      });
      setStatus(status);
      const { container, rerender } = renderPanel();

      fireEvent.click(container.querySelector('[data-testid="git-expand-diff"]')!);
      await waitFor(() => expect(container.textContent).toContain('FIRST FULL'));

      const refreshedStatus = makeStatus({
        files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
        review: {
          files: [
            makeFile({
              path: 'src/big.ts',
              patch: '+preview two',
              patchTruncated: true,
              additions: 1,
              deletions: 0,
            }),
          ],
          totalAdditions: 1,
          totalDeletions: 0,
          pullRequest: null,
          checks: [],
        },
      });
      mockedUseGitSessionStatus.mockReturnValue({
        status: refreshedStatus,
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      rerender(<GitPanel sessionId="session-1" />);

      await waitFor(() => expect(container.textContent).toContain('preview two'));
      expect(container.textContent).not.toContain('FIRST FULL');
    });

    it('preserves an expanded diff across a poll that does not change the file', async () => {
      mockedGetGitFileDiff.mockResolvedValue({
        sessionId: 'session-1',
        path: 'src/big.ts',
        patch: '+FULL UNCHANGED CONTENT',
        truncated: false,
        additions: 1,
        deletions: 0,
      });

      const status = makeStatus({
        files: [{ path: 'src/big.ts', status: 'modified', staged: false, unstaged: true }],
        review: {
          files: [makeFile({ path: 'src/big.ts', patch: '+preview', patchTruncated: true })],
          totalAdditions: 1,
          totalDeletions: 0,
          pullRequest: null,
          checks: [],
        },
      });
      setStatus(status);
      const { container, rerender } = renderPanel();

      fireEvent.click(container.querySelector('[data-testid="git-expand-diff"]')!);
      await waitFor(() => expect(container.textContent).toContain('FULL UNCHANGED CONTENT'));

      mockedUseGitSessionStatus.mockReturnValue({
        status,
        loading: false,
        error: null,
        refresh: vi.fn(),
      });
      rerender(<GitPanel sessionId="session-1" />);

      expect(container.textContent).toContain('FULL UNCHANGED CONTENT');
    });
  });

  describe('error handling', () => {
    it('keeps the last status visible and surfaces a refresh error non-destructively', () => {
      setStatus(makeStatus({ branch: 'main' }), { error: 'network error' });
      const { container } = renderPanel();

      expect(container.textContent).toContain('Review');
      expect(container.querySelector('[data-testid="git-status-error-banner"]')).toBeTruthy();
      expect(container.textContent).not.toContain('Git status unavailable');
    });
  });
});
