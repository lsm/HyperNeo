import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceWorkflowSummary } from '@hyperneo/shared';
import { ErrorDialog } from '../ErrorDialog.tsx';
import { Collapsible } from '../ui/Collapsible.tsx';
import { AutonomyWorkflowSummary } from '../space/AutonomyWorkflowSummary.tsx';
import { ErrorCategory } from '../../types/error.ts';

afterEach(cleanup);

describe('Error and workflow disclosures', () => {
  it('keeps technical details selectable and uses the explicit control', async () => {
    const view = render(
      <ErrorDialog
        isOpen
        onClose={vi.fn()}
        error={{
          category: ErrorCategory.SYSTEM,
          code: 'SYNTHETIC',
          message: 'Synthetic technical detail',
          userMessage: 'Synthetic error report',
          recoverable: true,
          timestamp: '2026-10-22T00:00:00Z',
        }}
      />
    );
    fireEvent.click(view.getByText('Technical Details', { exact: true }));
    const more = view.getByRole('button', { name: 'more — Technical Details', exact: true });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(more.getAttribute('aria-controls')!)).not.toBeNull();
    more.focus();
    fireEvent.click(more);
    const less = view.getByRole('button', { name: 'less — Technical Details', exact: true });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(less));
    fireEvent.click(view.getByText('Synthetic technical detail', { exact: true }));
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole('button', { name: 'more — Technical Details', exact: true })
      )
    );
  });

  it('preserves externally controlled state and callbacks', () => {
    const onChange = vi.fn();
    const content = (open: boolean) => (
      <Collapsible trigger={<span>Synthetic heading</span>} open={open} onOpenChange={onChange}>
        <p>Synthetic detail</p>
      </Collapsible>
    );
    const view = render(content(false));
    fireEvent.click(view.getByText('Synthetic heading'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'more — Details', exact: true }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    view.rerender(content(true));
    const less = view.getByRole('button', { name: 'less — Details', exact: true });
    expect(document.getElementById(less.getAttribute('aria-controls')!)).not.toBeNull();
    fireEvent.click(less);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(less.getAttribute('aria-expanded')).toBe('true');
    view.rerender(content(false));
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('supports default-open details without title toggling', () => {
    const view = render(
      <Collapsible trigger={<span>Synthetic heading</span>} defaultOpen>
        <p>Synthetic detail</p>
      </Collapsible>
    );
    fireEvent.click(view.getByText('Synthetic heading'));
    expect(
      view
        .getByRole('button', { name: 'less — Details', exact: true })
        .getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('keeps workflow counts inert and preserves blocking requirements', () => {
    const workflow: SpaceWorkflowSummary = {
      id: 'synthetic-workflow',
      spaceId: 'synthetic-space',
      tags: [],
      nodeCount: 0,
      createdAt: 0,
      updatedAt: 0,
      name: 'Synthetic blocked workflow',
      completionAutonomyLevel: 5,
    };
    const view = render(<AutonomyWorkflowSummary level={3} workflows={[workflow]} />);
    fireEvent.click(view.getByTestId('autonomy-workflow-summary-count'));
    const more = view.getByRole('button', { name: 'more — Workflow details', exact: true });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);
    const less = view.getByRole('button', { name: 'less — Workflow details', exact: true });
    expect(document.activeElement).toBe(less);
    fireEvent.click(view.getByText('Synthetic blocked workflow'));
    expect(view.getByText('Synthetic blocked workflow').parentElement?.textContent).toContain(
      'requires level 5'
    );
    expect(less.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(less);
    expect(view.queryByTestId('autonomy-workflow-summary-details')).toBeNull();
  });
  it.each(['workflows', 'level'])('removes the empty detail row after %s change', (change) => {
    const blocked: SpaceWorkflowSummary = {
      id: 'synthetic-workflow',
      spaceId: 'synthetic-space',
      name: 'Synthetic blocked workflow',
      tags: [],
      nodeCount: 0,
      createdAt: 0,
      updatedAt: 0,
      completionAutonomyLevel: 5,
    };
    const view = render(<AutonomyWorkflowSummary level={3} workflows={[blocked]} />);
    fireEvent.click(view.getByRole('button', { name: 'more — Workflow details', exact: true }));
    view.rerender(
      <AutonomyWorkflowSummary
        level={change === 'level' ? 5 : 3}
        workflows={[change === 'workflows' ? { ...blocked, completionAutonomyLevel: 2 } : blocked]}
      />
    );
    const summary = view.getByTestId('autonomy-workflow-summary');
    const count = view.getByTestId('autonomy-workflow-summary-count');
    expect(count.textContent).toContain('1 of 1');
    expect(view.queryByRole('button')).toBeNull();
    expect(view.queryByTestId('autonomy-workflow-summary-details')).toBeNull();
    expect(Array.from(summary.children, (row) => row.textContent?.trim())).toEqual([
      count.textContent?.trim(),
    ]);
    view.rerender(<AutonomyWorkflowSummary level={3} workflows={[blocked]} />);
    fireEvent.click(view.getByRole('button', { name: 'less — Workflow details', exact: true }));
    expect(view.getByRole('button', { name: 'more — Workflow details', exact: true })).toBeTruthy();
  });
});
