// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

vi.mock('../../../hooks/useSpaceTaskMessages', () => ({
  useSpaceTaskMessages: () => ({ rows: [] }),
}));

const mockRequest = vi.fn();
const mockOnEvent = vi.fn(() => () => {});
const mockHub = { request: mockRequest, onEvent: mockOnEvent };

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

vi.mock('../FileDiffView', () => ({
  FileDiffView: ({ filePath, onBack }: { filePath: string; onBack: () => void }) => (
    <div data-testid="file-diff-view" data-file={filePath}>
      <button data-testid="diff-back" onClick={onBack}>
        Back
      </button>
    </div>
  ),
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { TaskArtifactsPanel } from '../TaskArtifactsPanel';

const UNCOMMITTED_RESULT = {
  files: [
    { path: 'src/foo.ts', additions: 10, deletions: 2 },
    { path: 'src/bar.ts', additions: 5, deletions: 0 },
  ],
  totalAdditions: 15,
  totalDeletions: 2,
  isGitRepo: true,
};

const COMMITS_RESULT = {
  commits: [],
  baseRef: null,
  isGitRepo: true,
  repoUrl: null,
};

function setupDefaultMocks() {
  mockRequest.mockImplementation((method: string) => {
    if (method === 'spaceWorkflowRun.getGateArtifacts') return Promise.resolve(UNCOMMITTED_RESULT);
    if (method === 'spaceWorkflowRun.getCommits') return Promise.resolve(COMMITS_RESULT);
    return Promise.resolve({});
  });
}

describe('TaskArtifactsPanel', () => {
  beforeEach(() => {
    cleanup();
    mockRequest.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('has data-testid="artifacts-panel" on root element', async () => {
    setupDefaultMocks();
    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    expect(getByTestId('artifacts-panel')).toBeTruthy();
  });

  it('renders file list after successful fetch', async () => {
    setupDefaultMocks();
    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

    const fileList = getByTestId('artifacts-file-list');
    expect(fileList.textContent).toContain('src/foo.ts');
    expect(fileList.textContent).toContain('src/bar.ts');
  });

  it('shows +/- line counts for each file', async () => {
    setupDefaultMocks();
    const { container, getByTestId } = render(
      <TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
    );
    await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

    const fooRow = container.querySelector('[data-file-path="src/foo.ts"]');
    expect(fooRow).toBeTruthy();
    expect(fooRow?.textContent).toContain('+10');
    expect(fooRow?.textContent).toContain('-2');

    const barRow = container.querySelector('[data-file-path="src/bar.ts"]');
    expect(barRow).toBeTruthy();
    expect(barRow?.textContent).toContain('+5');
    expect(barRow?.textContent).toContain('-0');
  });

  it('shows no-files message when uncommitted files array is empty', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve({
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          isGitRepo: true,
        });
      if (method === 'spaceWorkflowRun.getCommits') return Promise.resolve(COMMITS_RESULT);
      return Promise.resolve({});
    });
    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() => expect(getByTestId('artifacts-no-files')).toBeTruthy());
  });

  it('clicking a file opens FileDiffView for that file', async () => {
    setupDefaultMocks();
    const { container, getByTestId, queryByTestId } = render(
      <TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
    );
    await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

    expect(queryByTestId('file-diff-view')).toBeNull();
    const fooRow = container.querySelector('[data-file-path="src/foo.ts"]') as HTMLElement;
    expect(fooRow).toBeTruthy();
    fireEvent.click(fooRow);
    const diffView = getByTestId('file-diff-view');
    expect(diffView).toBeTruthy();
    expect(diffView.getAttribute('data-file')).toBe('src/foo.ts');
  });

  it('back button in FileDiffView returns to file list', async () => {
    setupDefaultMocks();
    const { container, getByTestId, queryByTestId } = render(
      <TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
    );
    await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());

    const fooRow = container.querySelector('[data-file-path="src/foo.ts"]') as HTMLElement;
    fireEvent.click(fooRow);
    expect(getByTestId('file-diff-view')).toBeTruthy();

    fireEvent.click(getByTestId('diff-back'));
    expect(queryByTestId('file-diff-view')).toBeNull();
    expect(getByTestId('artifacts-file-list')).toBeTruthy();
  });

  it('shows error when not connected', async () => {
    const { connectionManager } = await import('../../../lib/connection-manager');
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValueOnce(null);

    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() => expect(getByTestId('artifacts-error')).toBeTruthy());
    expect(getByTestId('artifacts-error').textContent).toContain('Not connected');
  });

  it('shows fetch error when uncommitted request fails', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.reject(new Error('Server error'));
      if (method === 'spaceWorkflowRun.getCommits') return Promise.resolve(COMMITS_RESULT);
      return Promise.resolve({});
    });
    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() => expect(getByTestId('artifacts-error')).toBeTruthy());
    expect(getByTestId('artifacts-error').textContent).toContain('Server error');
  });

  it('fetches with the correct runId', async () => {
    setupDefaultMocks();
    render(<TaskArtifactsPanel runId="run-abc-123" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-abc-123',
      })
    );
  });

  it('shows commits section with no-commits message when commits list is empty', async () => {
    setupDefaultMocks();
    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() => expect(getByTestId('artifacts-commits-list')).toBeTruthy());
    expect(getByTestId('artifacts-commits-list').textContent).toContain('No commits yet');
  });

  it('shows commit rows when commits are returned', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve(UNCOMMITTED_RESULT);
      if (method === 'spaceWorkflowRun.getCommits')
        return Promise.resolve({
          commits: [
            {
              sha: 'abc1234',
              message: 'feat: add feature',
              author: 'Dev',
              timestamp: Date.now(),
              additions: 10,
              deletions: 2,
              fileCount: 3,
            },
          ],
          baseRef: 'origin/dev',
          isGitRepo: true,
          repoUrl: null,
        });
      return Promise.resolve({});
    });

    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(getByTestId('artifacts-commits-list').textContent).toContain('feat: add feature')
    );
    expect(getByTestId('artifacts-commits-list').textContent).toContain('abc1234');
  });

  it('shows commit author in each commit row', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve(UNCOMMITTED_RESULT);
      if (method === 'spaceWorkflowRun.getCommits')
        return Promise.resolve({
          commits: [
            {
              sha: 'abc1234',
              message: 'feat: add feature',
              author: 'Alice',
              timestamp: Date.now(),
              additions: 10,
              deletions: 2,
              fileCount: 3,
            },
          ],
          baseRef: 'origin/dev',
          isGitRepo: true,
          repoUrl: null,
        });
      return Promise.resolve({});
    });

    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(getByTestId('artifacts-commits-list').textContent).toContain('Alice')
    );
    expect(
      getByTestId('artifacts-commits-list').querySelector('[data-testid="artifacts-commit-author"]')
        ?.textContent
    ).toBe('Alice');
  });

  it('shows relative time in each commit row', async () => {
    const recentTimestamp = Date.now() - 5 * 60 * 1000;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve(UNCOMMITTED_RESULT);
      if (method === 'spaceWorkflowRun.getCommits')
        return Promise.resolve({
          commits: [
            {
              sha: 'abc1234',
              message: 'feat: add feature',
              author: 'Alice',
              timestamp: recentTimestamp,
              additions: 0,
              deletions: 0,
              fileCount: 0,
            },
          ],
          baseRef: 'origin/dev',
          isGitRepo: true,
          repoUrl: null,
        });
      return Promise.resolve({});
    });

    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(
        getByTestId('artifacts-commits-list').querySelector('[data-testid="artifacts-commit-time"]')
      ).toBeTruthy()
    );
    const timeEl = getByTestId('artifacts-commits-list').querySelector(
      '[data-testid="artifacts-commit-time"]'
    );
    expect(timeEl?.textContent).toMatch(/\d+[smhd] ago/);
  });

  it('shows GitHub commit link when repoUrl is available', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve(UNCOMMITTED_RESULT);
      if (method === 'spaceWorkflowRun.getCommits')
        return Promise.resolve({
          commits: [
            {
              sha: 'abc1234def5678',
              message: 'feat: add feature',
              author: 'Alice',
              timestamp: Date.now(),
              additions: 0,
              deletions: 0,
              fileCount: 0,
            },
          ],
          baseRef: 'origin/dev',
          isGitRepo: true,
          repoUrl: 'https://github.com/owner/repo',
        });
      return Promise.resolve({});
    });

    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(
        getByTestId('artifacts-commits-list').querySelector(
          '[data-testid="artifacts-commit-sha-link"]'
        )
      ).toBeTruthy()
    );
    const link = getByTestId('artifacts-commits-list').querySelector(
      '[data-testid="artifacts-commit-sha-link"]'
    ) as HTMLAnchorElement;
    expect(link.href).toContain('https://github.com/owner/repo/commit/abc1234def5678');
    expect(link.textContent).toBe('abc1234');
  });

  it('does not show GitHub link when repoUrl is null', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve(UNCOMMITTED_RESULT);
      if (method === 'spaceWorkflowRun.getCommits')
        return Promise.resolve({
          commits: [
            {
              sha: 'abc1234',
              message: 'feat: add feature',
              author: 'Alice',
              timestamp: Date.now(),
              additions: 0,
              deletions: 0,
              fileCount: 0,
            },
          ],
          baseRef: 'origin/dev',
          isGitRepo: true,
          repoUrl: null,
        });
      return Promise.resolve({});
    });

    const { getByTestId } = render(<TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(getByTestId('artifacts-commits-list').textContent).toContain('abc1234')
    );
    expect(
      getByTestId('artifacts-commits-list').querySelector(
        '[data-testid="artifacts-commit-sha-link"]'
      )
    ).toBeNull();
  });

  it('shows Files Touched section (not Commits) when isGitRepo is false', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'spaceWorkflowRun.getGateArtifacts')
        return Promise.resolve({
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          isGitRepo: false,
        });
      if (method === 'spaceWorkflowRun.getCommits')
        return Promise.resolve({ commits: [], baseRef: null, isGitRepo: false });
      return Promise.resolve({});
    });

    const { getByTestId, queryByTestId } = render(
      <TaskArtifactsPanel runId="run-1" onClose={vi.fn()} />
    );
    await waitFor(() => expect(getByTestId('artifacts-file-list')).toBeTruthy());
    expect(queryByTestId('artifacts-commits-list')).toBeNull();
  });
});

describe('TaskAuxiliaryPanel — artifacts section', () => {
  let mockTasks: ReturnType<typeof import('@preact/signals').signal>;

  beforeEach(async () => {
    cleanup();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
  });

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task-1',
      spaceId: 'space-1',
      taskNumber: 1,
      title: 'Test Task',
      description: '',
      status: 'in_progress',
      priority: 'normal',
      dependsOn: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workflowRunId: 'run-xyz',
      taskAgentSessionId: 'session-abc',
      ...overrides,
    };
  }

  async function renderAuxiliaryPanel(task: Record<string, unknown>) {
    const { signal } = await import('@preact/signals');
    mockTasks = signal([task]);

    vi.doMock('../../../lib/space-store', () => ({
      get spaceStore() {
        return {
          tasks: mockTasks,
          space: signal(null),
          ensureConfigData: vi.fn().mockResolvedValue(undefined),
          fetchEvolutionScope: vi.fn().mockResolvedValue(null),
          updateTask: vi.fn().mockResolvedValue(undefined),
          submitForReview: vi.fn().mockResolvedValue(undefined),
          publishTask: vi.fn().mockResolvedValue(undefined),
          workflows: signal([]),
          workflowRuns: signal([]),
          goals: signal([]),
          schedules: signal([]),
        };
      },
    }));
    vi.doMock('../TaskArtifactsPanel', () => ({
      TaskArtifactsPanel: ({ runId }: { runId: string }) => (
        <div data-testid="artifacts-panel" data-run-id={runId} />
      ),
    }));
    vi.doMock('../TaskTimelineFeed', () => ({
      TaskTimelineFeed: () => <div data-testid="timeline-panel" />,
    }));
    vi.doMock('../../../lib/utils', () => ({
      cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
    }));
    vi.doMock('../TaskStatusActions', () => ({
      getTransitionActions: () => [],
    }));
    vi.doMock('../../../lib/router', () => ({
      navigateToSpaceEvolve: vi.fn(),
      navigateToSpaceGoals: vi.fn(),
    }));
    vi.doMock('../ui/Dropdown', () => ({
      Dropdown: ({ children }: { children: unknown }) => <>{children}</>,
    }));

    const { TaskAuxiliaryPanel } = await import('../TaskAuxiliaryPanel');
    return render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" />);
  }

  it('renders the artifacts section when task has workflowRunId', async () => {
    const { getByTestId } = await renderAuxiliaryPanel(makeTask());

    expect(getByTestId('artifacts-panel').getAttribute('data-run-id')).toBe('run-xyz');
  });

  it('does not render the artifacts section when task has no workflowRunId', async () => {
    const { queryByTestId } = await renderAuxiliaryPanel(makeTask({ workflowRunId: null }));

    expect(queryByTestId('artifacts-panel')).toBeNull();
  });
});
