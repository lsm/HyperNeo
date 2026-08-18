import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ImportPreviewDialog } from '../ImportPreviewDialog.tsx';
import type { ImportPreviewResult, ImportConflictResolution } from '../ImportPreviewDialog.tsx';
import type { SpaceExportBundle } from '@hyperneo/shared';

const makeBundle = (): SpaceExportBundle => ({
  version: 2,
  type: 'bundle',
  name: 'Test Bundle',
  agents: [],
  workflows: [],
  exportedAt: Date.now(),
});

const makePreview = (overrides: Partial<ImportPreviewResult> = {}): ImportPreviewResult => ({
  agents: [],
  workflows: [],
  validationErrors: [],
  ...overrides,
});

describe('ImportPreviewDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ImportPreviewDialog
        isOpen={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={makePreview()}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders title when open', () => {
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={makePreview()}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(screen.getByText('Import Preview')).toBeTruthy();
  });

  it('shows new agents as "new"', () => {
    const preview = makePreview({
      agents: [{ name: 'Agent One', action: 'create' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(screen.getByText('Agent One')).toBeTruthy();
    expect(screen.getAllByText('new').length).toBeGreaterThan(0);
  });

  it('shows conflict agents with dropdown', () => {
    const preview = makePreview({
      agents: [{ name: 'Agent Two', action: 'conflict', existingId: 'existing-id' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(screen.getByText('conflict')).toBeTruthy();
    const select = screen.getByLabelText(/Conflict resolution for Agent Two/i) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('skip');
  });

  it('Import button disabled when all conflicts are skip', () => {
    const preview = makePreview({
      agents: [{ name: 'Agent Two', action: 'conflict', existingId: 'id' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    const importBtn = screen.getByRole('button', { name: /^Import$/ }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
  });

  it('Import button enabled when conflict is changed to rename', () => {
    const preview = makePreview({
      agents: [{ name: 'Agent Two', action: 'conflict', existingId: 'id' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    const select = screen.getByLabelText(/Conflict resolution for Agent Two/i) as HTMLSelectElement;
    fireEvent.input(select, { target: { value: 'rename' } });

    const importBtn = screen.getByRole('button', { name: /^Import$/ }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
  });

  it('calls onConfirm with correct resolution when Import clicked', () => {
    const onConfirm = vi.fn();
    const preview = makePreview({
      agents: [{ name: 'Agent Two', action: 'conflict', existingId: 'id' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    const select = screen.getByLabelText(/Conflict resolution for Agent Two/i) as HTMLSelectElement;
    fireEvent.input(select, { target: { value: 'replace' } });

    const importBtn = screen.getByRole('button', { name: /^Import$/ });
    fireEvent.click(importBtn);

    expect(onConfirm).toHaveBeenCalledOnce();
    const resolution = onConfirm.mock.calls[0][0] as ImportConflictResolution;
    expect(resolution.agents?.['Agent Two']).toBe('replace');
  });

  it('shows validation errors', () => {
    const preview = makePreview({
      validationErrors: ['step "s1" references unknown agent "Foo"'],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(/Validation errors/i)).toBeTruthy();
    expect(screen.getByText(/step "s1" references unknown agent/i)).toBeTruthy();
  });

  it('shows both agents and workflows sections', () => {
    const preview = makePreview({
      agents: [{ name: 'Agent A', action: 'create' }],
      workflows: [{ name: 'Flow B', action: 'create' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(/Agents \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/Workflows \(1\)/i)).toBeTruthy();
    expect(screen.getByText('Agent A')).toBeTruthy();
    expect(screen.getByText('Flow B')).toBeTruthy();
  });

  it('shows correct summary count', () => {
    const preview = makePreview({
      agents: [
        { name: 'A', action: 'create' },
        { name: 'B', action: 'create' },
      ],
      workflows: [{ name: 'W', action: 'create' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    expect(screen.getByText(/Will import/)).toBeTruthy();
    const summaryText = screen.getByText(/Will import/).textContent;
    expect(summaryText).toContain('2');
    expect(summaryText).toContain('1');
  });

  it('shows spinner and disables buttons during execution', () => {
    const preview = makePreview({
      agents: [{ name: 'A', action: 'create' }],
    });
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        preview={preview}
        bundle={makeBundle()}
        isExecuting={true}
      />
    );
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i }) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
  });

  it('calls onClose when Cancel clicked', () => {
    const onClose = vi.fn();
    render(
      <ImportPreviewDialog
        isOpen={true}
        onClose={onClose}
        onConfirm={vi.fn()}
        preview={makePreview()}
        bundle={makeBundle()}
        isExecuting={false}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
