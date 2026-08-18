import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceWorkflowSummary, DuplicateDriftReport } from '@hyperneo/shared';

const mockLoading: Signal<boolean> = signal(false);

const mockDeleteWorkflow = vi.fn();

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      loading: mockLoading,
      deleteWorkflow: mockDeleteWorkflow,
    };
  },
}));

const mockHubRequest = vi.fn();

vi.mock('../../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockHubRequest }),
  },
}));
vi.mock('../../../lib/toast.ts', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../ImportPreviewDialog.tsx', () => ({ ImportPreviewDialog: () => null }));
vi.mock('../export-import-utils.ts', () => ({
  downloadBundle: vi.fn(),
  pickImportFile: vi.fn(),
}));

import { WorkflowList } from '../WorkflowList';
import { toast } from '../../../lib/toast.ts';

function makeWorkflow(overrides: Partial<SpaceWorkflowSummary> = {}): SpaceWorkflowSummary {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'My Workflow',
    description: 'Does stuff',
    nodeCount: 2,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

const defaultProps = {
  spaceId: 'space-1',
  spaceName: 'Test Space',
  workflows: [] as SpaceWorkflowSummary[],
  onCreateWorkflow: vi.fn(),
  onEditWorkflow: vi.fn(),
};

describe('WorkflowList', () => {
  beforeEach(() => {
    cleanup();
    mockLoading.value = false;
    mockDeleteWorkflow.mockResolvedValue(undefined);
    defaultProps.workflows = [];
    defaultProps.onCreateWorkflow.mockClear();
    defaultProps.onEditWorkflow.mockClear();
    mockHubRequest.mockReset();
    mockHubRequest.mockImplementation(async (method: string) => {
      if (method === 'spaceWorkflow.detectDuplicateDrift') return { reports: [] };
      if (method === 'spaceWorkflow.detectDrift')
        return { updateAvailable: false, customized: false };
      return undefined;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading spinner when loading', () => {
    mockLoading.value = true;
    const { container } = render(<WorkflowList {...defaultProps} />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders empty state when no workflows', () => {
    const { getByText } = render(<WorkflowList {...defaultProps} />);
    expect(getByText('No workflows yet')).toBeTruthy();
    expect(getByText('Create your first workflow')).toBeTruthy();
  });

  it('renders Workflows heading', () => {
    const { getByText } = render(<WorkflowList {...defaultProps} />);
    expect(getByText('0 workflows')).toBeTruthy();
  });

  it('renders Create Workflow button in header', () => {
    const { getByText } = render(<WorkflowList {...defaultProps} />);
    expect(getByText('Create Workflow')).toBeTruthy();
  });

  it('calls onCreateWorkflow when header Create button clicked', () => {
    const { getByText } = render(<WorkflowList {...defaultProps} />);
    fireEvent.click(getByText('Create Workflow'));
    expect(defaultProps.onCreateWorkflow).toHaveBeenCalledOnce();
  });

  it('calls onCreateWorkflow when empty-state CTA clicked', () => {
    const { getByText } = render(<WorkflowList {...defaultProps} />);
    fireEvent.click(getByText('Create your first workflow'));
    expect(defaultProps.onCreateWorkflow).toHaveBeenCalled();
  });

  it('renders workflow card with name', () => {
    const props = { ...defaultProps, workflows: [makeWorkflow({ name: 'Feature Pipeline' })] };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('Feature Pipeline')).toBeTruthy();
  });

  it('renders workflow description', () => {
    const props = {
      ...defaultProps,
      workflows: [makeWorkflow({ description: 'Runs features end-to-end' })],
    };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('Runs features end-to-end')).toBeTruthy();
  });

  it('renders step count', () => {
    const props = { ...defaultProps, workflows: [makeWorkflow()] };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('2 steps')).toBeTruthy();
  });

  it('renders singular "1 step"', () => {
    const props = {
      ...defaultProps,
      workflows: [makeWorkflow({ nodeCount: 1 })],
    };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('1 step')).toBeTruthy();
  });

  it('renders tag chips', () => {
    const props = { ...defaultProps, workflows: [makeWorkflow({ tags: ['ci', 'dev'] })] };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('ci')).toBeTruthy();
    expect(getByText('dev')).toBeTruthy();
  });

  it('renders mini step dots (one per step)', () => {
    const props = { ...defaultProps, workflows: [makeWorkflow()] };
    const { container } = render(<WorkflowList {...props} />);
    const dots = container.querySelectorAll('.bg-blue-400, .bg-blue-500');
    expect(dots.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onEditWorkflow with workflow ID when Edit clicked', () => {
    const props = { ...defaultProps, workflows: [makeWorkflow({ id: 'wf-abc' })] };
    const { getByText } = render(<WorkflowList {...props} />);
    fireEvent.click(getByText('Edit'));
    expect(defaultProps.onEditWorkflow).toHaveBeenCalledWith('wf-abc');
  });

  describe('template drift badge + apply', () => {
    function workflowWithTemplate(): SpaceWorkflowSummary {
      return makeWorkflow({ id: 'wf-1', templateName: 'Coding Workflow' });
    }

    function driftDetect(updateAvailable: boolean, customized: boolean): typeof mockHubRequest {
      return vi.fn(async (method: string) => {
        if (method === 'spaceWorkflow.detectDuplicateDrift') return { reports: [] };
        if (method === 'spaceWorkflow.detectDrift') return { updateAvailable, customized };
        return undefined;
      });
    }

    it('renders an Update available badge and Apply update button when only an update is pending', async () => {
      mockHubRequest.mockImplementation(driftDetect(true, false));
      const props = { ...defaultProps, workflows: [workflowWithTemplate()] };
      const { getByText, queryByText } = render(<WorkflowList {...props} />);

      await waitFor(() => expect(getByText('Update available')).toBeTruthy());
      expect(queryByText('Customized')).toBeNull();
      expect(getByText('Apply update')).toBeTruthy();
    });

    it('renders both badges and a Review diff button for a customized row with an update', async () => {
      mockHubRequest.mockImplementation(driftDetect(true, true));
      const props = { ...defaultProps, workflows: [workflowWithTemplate()] };
      const { getByText, queryByText } = render(<WorkflowList {...props} />);

      await waitFor(() => expect(getByText('Update available')).toBeTruthy());
      expect(getByText('Customized')).toBeTruthy();
      expect(queryByText('Apply update')).toBeNull();
      expect(getByText('Review diff')).toBeTruthy();
    });

    it('renders a quiet Customized badge and no action when only customized', async () => {
      mockHubRequest.mockImplementation(driftDetect(false, true));
      const props = { ...defaultProps, workflows: [workflowWithTemplate()] };
      const { getByText, queryByText } = render(<WorkflowList {...props} />);

      await waitFor(() => expect(getByText('Customized')).toBeTruthy());
      expect(queryByText('Update available')).toBeNull();
      expect(queryByText('Apply update')).toBeNull();
      expect(queryByText('Review diff')).toBeNull();
    });

    it('renders no drift badge or action for a pristine row', async () => {
      mockHubRequest.mockImplementation(driftDetect(false, false));
      const props = { ...defaultProps, workflows: [workflowWithTemplate()] };
      const { queryByText } = render(<WorkflowList {...props} />);

      await waitFor(() =>
        expect(mockHubRequest).toHaveBeenCalledWith('spaceWorkflow.detectDrift', {
          id: 'wf-1',
          spaceId: 'space-1',
        })
      );
      expect(queryByText('Update available')).toBeNull();
      expect(queryByText('Customized')).toBeNull();
      expect(queryByText('Apply update')).toBeNull();
    });
  });

  it('renders multiple workflows', () => {
    const props = {
      ...defaultProps,
      workflows: [
        makeWorkflow({ id: 'wf-1', name: 'Alpha' }),
        makeWorkflow({ id: 'wf-2', name: 'Beta' }),
      ],
    };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('Alpha')).toBeTruthy();
    expect(getByText('Beta')).toBeTruthy();
  });

  it('handles workflow with no steps in mini viz', () => {
    const props = {
      ...defaultProps,
      workflows: [makeWorkflow({ nodeCount: 0 })],
    };
    const { getByText } = render(<WorkflowList {...props} />);
    expect(getByText('No steps')).toBeTruthy();
  });

  describe('delete workflow', () => {
    it('shows inline Delete? confirmation when trash icon clicked', () => {
      const props = { ...defaultProps, workflows: [makeWorkflow()] };
      const { getByText, container } = render(<WorkflowList {...props} />);
      const trashBtn = container.querySelector(
        'button[title="Delete workflow"]'
      ) as HTMLButtonElement;
      expect(trashBtn).toBeTruthy();
      fireEvent.click(trashBtn);
      expect(getByText('Delete?')).toBeTruthy();
      expect(getByText('Confirm')).toBeTruthy();
      expect(getByText('Cancel')).toBeTruthy();
    });

    it('calls deleteWorkflow when Confirm clicked', async () => {
      const props = { ...defaultProps, workflows: [makeWorkflow({ id: 'wf-del' })] };
      const { getByText, container } = render(<WorkflowList {...props} />);
      const trashBtn = container.querySelector(
        'button[title="Delete workflow"]'
      ) as HTMLButtonElement;
      fireEvent.click(trashBtn);
      fireEvent.click(getByText('Confirm'));
      await waitFor(() => {
        expect(mockDeleteWorkflow).toHaveBeenCalledWith('wf-del');
      });
    });

    it('hides confirmation when Cancel clicked', () => {
      const props = { ...defaultProps, workflows: [makeWorkflow()] };
      const { getByText, queryByText, container } = render(<WorkflowList {...props} />);
      const trashBtn = container.querySelector(
        'button[title="Delete workflow"]'
      ) as HTMLButtonElement;
      fireEvent.click(trashBtn);
      expect(getByText('Delete?')).toBeTruthy();
      fireEvent.click(getByText('Cancel'));
      expect(queryByText('Delete?')).toBeNull();
    });

    it('shows error banner when deleteWorkflow fails', async () => {
      mockDeleteWorkflow.mockRejectedValueOnce(new Error('Delete failed'));
      const props = { ...defaultProps, workflows: [makeWorkflow()] };
      const { getByText, container } = render(<WorkflowList {...props} />);
      const trashBtn = container.querySelector(
        'button[title="Delete workflow"]'
      ) as HTMLButtonElement;
      fireEvent.click(trashBtn);
      fireEvent.click(getByText('Confirm'));
      await waitFor(() => {
        expect(getByText('Delete failed')).toBeTruthy();
      });
    });
  });

  describe('duplicate-drift badge + resync', () => {
    function driftReport(
      templateName: string,
      rows: Array<{ id: string; templateHash: string | null; createdAt: number }>
    ): DuplicateDriftReport {
      return { templateName, rows };
    }

    it('renders a Duplicate badge on each workflow in a drift group', async () => {
      mockHubRequest.mockImplementation(async (method: string) => {
        if (method === 'spaceWorkflow.detectDuplicateDrift') {
          return {
            reports: [
              driftReport('Coding Workflow', [
                { id: 'wf-newer', templateHash: 'new', createdAt: 200 },
                { id: 'wf-older', templateHash: 'old', createdAt: 100 },
              ]),
            ],
          };
        }
        if (method === 'spaceWorkflow.detectDrift')
          return { updateAvailable: false, customized: false };
        return undefined;
      });

      const props = {
        ...defaultProps,
        workflows: [
          makeWorkflow({ id: 'wf-newer', name: 'Newer', templateName: 'Coding Workflow' }),
          makeWorkflow({ id: 'wf-older', name: 'Older', templateName: 'Coding Workflow' }),
        ],
      };
      const { findAllByText } = render(<WorkflowList {...props} />);
      const badges = await findAllByText(/Duplicate ×2/);
      expect(badges.length).toBe(2);
    });

    it('shows "Resync duplicates" button only on the newest row', async () => {
      mockHubRequest.mockImplementation(async (method: string) => {
        if (method === 'spaceWorkflow.detectDuplicateDrift') {
          return {
            reports: [
              driftReport('Coding Workflow', [
                { id: 'wf-newer', templateHash: 'new', createdAt: 200 },
                { id: 'wf-older', templateHash: 'old', createdAt: 100 },
              ]),
            ],
          };
        }
        if (method === 'spaceWorkflow.detectDrift')
          return { updateAvailable: false, customized: false };
        return undefined;
      });

      const props = {
        ...defaultProps,
        workflows: [
          makeWorkflow({ id: 'wf-newer', name: 'Newer', templateName: 'Coding Workflow' }),
          makeWorkflow({ id: 'wf-older', name: 'Older', templateName: 'Coding Workflow' }),
        ],
      };
      const { findAllByText } = render(<WorkflowList {...props} />);
      const buttons = await findAllByText('Resync duplicates');
      expect(buttons.length).toBe(1);
    });

    it('opens the resync confirmation dialog when button clicked', async () => {
      mockHubRequest.mockImplementation(async (method: string) => {
        if (method === 'spaceWorkflow.detectDuplicateDrift') {
          return {
            reports: [
              driftReport('Coding Workflow', [
                { id: 'wf-newer', templateHash: 'new', createdAt: 200 },
                { id: 'wf-older', templateHash: 'old', createdAt: 100 },
              ]),
            ],
          };
        }
        if (method === 'spaceWorkflow.detectDrift')
          return { updateAvailable: false, customized: false };
        return undefined;
      });

      const props = {
        ...defaultProps,
        workflows: [
          makeWorkflow({ id: 'wf-newer', name: 'Newer', templateName: 'Coding Workflow' }),
          makeWorkflow({ id: 'wf-older', name: 'Older', templateName: 'Coding Workflow' }),
        ],
      };
      const { findByText, getByText } = render(<WorkflowList {...props} />);
      const btn = await findByText('Resync duplicates');
      fireEvent.click(btn);
      expect(getByText('Resync duplicate workflows?')).toBeTruthy();
      expect(getByText('Delete older rows & resync')).toBeTruthy();
    });

    it('calls resyncDuplicates RPC when confirmed', async () => {
      mockHubRequest.mockImplementation(async (method: string, params: unknown) => {
        if (method === 'spaceWorkflow.detectDuplicateDrift') {
          return {
            reports: [
              driftReport('Coding Workflow', [
                { id: 'wf-newer', templateHash: 'new', createdAt: 200 },
                { id: 'wf-older', templateHash: 'old', createdAt: 100 },
              ]),
            ],
          };
        }
        if (method === 'spaceWorkflow.detectDrift')
          return { updateAvailable: false, customized: false };
        if (method === 'spaceWorkflow.resyncDuplicates') {
          expect(params).toMatchObject({
            spaceId: 'space-1',
            templateName: 'Coding Workflow',
          });
          return { deletedIds: ['wf-older'] };
        }
        return undefined;
      });

      const props = {
        ...defaultProps,
        workflows: [
          makeWorkflow({ id: 'wf-newer', name: 'Newer', templateName: 'Coding Workflow' }),
          makeWorkflow({ id: 'wf-older', name: 'Older', templateName: 'Coding Workflow' }),
        ],
      };
      const { findByText, getByText } = render(<WorkflowList {...props} />);
      const btn = await findByText('Resync duplicates');
      fireEvent.click(btn);
      fireEvent.click(getByText('Delete older rows & resync'));
      await waitFor(() => {
        expect(mockHubRequest).toHaveBeenCalledWith(
          'spaceWorkflow.resyncDuplicates',
          expect.objectContaining({
            spaceId: 'space-1',
            templateName: 'Coding Workflow',
          })
        );
      });
    });

    it('warns about duplicates kept due to active runs (partial resync)', async () => {
      vi.mocked(toast.success).mockClear();
      vi.mocked(toast.warning).mockClear();
      mockHubRequest.mockImplementation(async (method: string) => {
        if (method === 'spaceWorkflow.detectDuplicateDrift') {
          return {
            reports: [
              driftReport('Coding Workflow', [
                { id: 'wf-newer', templateHash: 'new', createdAt: 200 },
                { id: 'wf-older', templateHash: 'old', createdAt: 100 },
              ]),
            ],
          };
        }
        if (method === 'spaceWorkflow.detectDrift')
          return { updateAvailable: false, customized: false };
        if (method === 'spaceWorkflow.resyncDuplicates') {
          return { deletedIds: [], skippedDueToExecutableRuns: ['wf-older'] };
        }
        return undefined;
      });

      const props = {
        ...defaultProps,
        workflows: [
          makeWorkflow({ id: 'wf-newer', name: 'Newer', templateName: 'Coding Workflow' }),
          makeWorkflow({ id: 'wf-older', name: 'Older', templateName: 'Coding Workflow' }),
        ],
      };
      const { findByText, getByText } = render(<WorkflowList {...props} />);
      fireEvent.click(await findByText('Resync duplicates'));
      fireEvent.click(getByText('Delete older rows & resync'));
      await waitFor(() => {
        expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('kept 1 duplicate'));
      });
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('renders no Duplicate badge when the RPC returns no reports', async () => {
      const props = {
        ...defaultProps,
        workflows: [makeWorkflow({ id: 'wf-a', name: 'Only', templateName: 'Coding Workflow' })],
      };
      const { queryByText } = render(<WorkflowList {...props} />);
      await waitFor(() => {
        expect(mockHubRequest).toHaveBeenCalledWith(
          'spaceWorkflow.detectDuplicateDrift',
          expect.objectContaining({ spaceId: 'space-1' })
        );
      });
      expect(queryByText(/Duplicate ×/)).toBeNull();
      expect(queryByText('Resync duplicates')).toBeNull();
    });
  });
});
