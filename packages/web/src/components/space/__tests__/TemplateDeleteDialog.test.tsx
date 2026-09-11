import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { fireEvent, render } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { TemplateDeleteDialog } from '../TemplateDeleteDialog';

const template = {
  key: 'researcher.v1',
  displayName: 'Researcher',
  version: 3,
} as unknown as SpaceLongHorizonAgentTemplate;

function renderDialog(overrides: Partial<Parameters<typeof TemplateDeleteDialog>[0]> = {}) {
  const props = {
    template,
    busy: false,
    error: null,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TemplateDeleteDialog {...props} />) };
}

describe('TemplateDeleteDialog', () => {
  it('names the template in the warning', () => {
    const { getByText } = renderDialog();

    expect(getByText(/Delete template "Researcher"\?/)).toBeTruthy();
  });

  it('confirms through the supplied handler', () => {
    const { props, getByTestId } = renderDialog();

    fireEvent.click(getByTestId('confirm-delete-template'));

    expect(props.onConfirm).toHaveBeenCalled();
  });

  it('disables confirmation while busy', () => {
    const { props, getByTestId } = renderDialog({ busy: true });

    fireEvent.click(getByTestId('confirm-delete-template'));

    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('shows the supplied error', () => {
    const { getByText } = renderDialog({ error: 'template still referenced' });

    expect(getByText('template still referenced')).toBeTruthy();
  });
});
