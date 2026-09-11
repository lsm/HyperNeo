import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDeleteTemplate, mockSuccess } = vi.hoisted(() => ({
  mockDeleteTemplate: vi.fn(),
  mockSuccess: vi.fn(),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { deleteTemplate: mockDeleteTemplate },
}));

vi.mock('../../../lib/toast', () => ({
  toast: { success: mockSuccess, error: vi.fn() },
}));

import { TemplateDeleteDialog } from '../TemplateDeleteDialog';

const template = {
  key: 'researcher.v1',
  displayName: 'Researcher',
  version: 3,
} as unknown as SpaceLongHorizonAgentTemplate;

describe('TemplateDeleteDialog', () => {
  beforeEach(() => {
    mockDeleteTemplate.mockReset().mockResolvedValue(undefined);
    mockSuccess.mockReset();
  });

  it('deletes the template at its pinned version and closes', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<TemplateDeleteDialog template={template} onClose={onClose} />);

    fireEvent.click(getByTestId('confirm-delete-template'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockDeleteTemplate).toHaveBeenCalledWith('researcher.v1', 3);
  });

  it('ignores Escape while the delete is in flight', async () => {
    let release = (): void => {};
    mockDeleteTemplate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    const onClose = vi.fn();
    const { getByTestId } = render(<TemplateDeleteDialog template={template} onClose={onClose} />);

    fireEvent.click(getByTestId('confirm-delete-template'));
    await waitFor(() => expect(mockDeleteTemplate).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('allows Escape before the delete starts', () => {
    const onClose = vi.fn();
    render(<TemplateDeleteDialog template={template} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the failure message', async () => {
    mockDeleteTemplate.mockRejectedValue(new Error('template still referenced'));
    const onClose = vi.fn();
    const { getByTestId, findByText } = render(
      <TemplateDeleteDialog template={template} onClose={onClose} />
    );

    fireEvent.click(getByTestId('confirm-delete-template'));

    expect(await findByText('template still referenced')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
