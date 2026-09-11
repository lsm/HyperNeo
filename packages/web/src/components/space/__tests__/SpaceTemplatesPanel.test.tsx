import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { fireEvent, render } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../TemplateEditor', () => ({
  TemplateEditor: ({ template }: { template: SpaceLongHorizonAgentTemplate | null }) => (
    <div data-testid="template-editor">{template ? template.key : 'new'}</div>
  ),
}));

import { SpaceTemplatesPanel } from '../SpaceTemplatesPanel';
import { openTemplateDelete, templateDeleteRequest } from '../template-delete-request';

function makeTemplate(key: string, labels?: string[]): SpaceLongHorizonAgentTemplate {
  return {
    key,
    handle: key,
    displayName: key,
    description: '',
    labels,
    toolPermissions: {},
  } as unknown as SpaceLongHorizonAgentTemplate;
}

function renderPanel(overrides: Partial<Parameters<typeof SpaceTemplatesPanel>[0]> = {}) {
  const props = {
    spaceId: 'space-1',
    templates: [makeTemplate('researcher.v1')],
    templateInstanceCounts: new Map<string, number>(),
    userTemplateKeys: new Set<string>(),
    onUseTemplate: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SpaceTemplatesPanel {...props} />) };
}

describe('SpaceTemplatesPanel', () => {
  beforeEach(() => {
    templateDeleteRequest.value = null;
  });

  it('shows a delete request raised in this Space', () => {
    openTemplateDelete('space-1', makeTemplate('researcher.v1'));

    const { getByTestId } = renderPanel();

    expect(getByTestId('confirm-delete-template')).toBeTruthy();
  });

  it('ignores a delete request belonging to another Space', () => {
    openTemplateDelete('space-2', makeTemplate('researcher.v1'));

    const { queryByTestId } = renderPanel();

    expect(queryByTestId('confirm-delete-template')).toBeNull();
  });

  it('raises the delete request for the clicked template', () => {
    const { getByLabelText } = renderPanel({
      userTemplateKeys: new Set(['researcher.v1']),
    });

    fireEvent.click(getByLabelText('Delete template researcher.v1'));

    expect(templateDeleteRequest.value).toMatchObject({
      spaceId: 'space-1',
      template: expect.objectContaining({ key: 'researcher.v1' }),
    });
  });

  it('counts the templates it was given', () => {
    const { getByTestId } = renderPanel({
      templates: [makeTemplate('a'), makeTemplate('b')],
    });

    expect(getByTestId('agent-template-count').textContent).toBe('2');
  });

  it('groups templates by label', () => {
    const { getByTestId } = renderPanel({
      templates: [makeTemplate('w', ['workflow-worker']), makeTemplate('c')],
    });

    expect(getByTestId('agent-template-group-workflow-worker')).toBeTruthy();
    expect(getByTestId('agent-template-group-custom')).toBeTruthy();
  });

  it('hands a clicked template back to the host rather than handling it', () => {
    const { props, getByText } = renderPanel();

    fireEvent.click(getByText('researcher.v1'));

    expect(props.onUseTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'researcher.v1' })
    );
  });

  it('opens its own editor for a new template', () => {
    const { getByText, getByTestId } = renderPanel();

    fireEvent.click(getByText('New Template'));

    expect(getByTestId('template-editor').textContent).toBe('new');
  });

  it('does not render the editor until it is asked for', () => {
    const { queryByTestId } = renderPanel();

    expect(queryByTestId('template-editor')).toBeNull();
  });
});
