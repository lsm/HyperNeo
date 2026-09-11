import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { fireEvent, render } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTemplates, mockUserTemplateKeys } = vi.hoisted(() => ({
  mockTemplates: { value: [] as SpaceLongHorizonAgentTemplate[] },
  mockUserTemplateKeys: { value: new Set<string>() },
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: { agentTemplates: mockTemplates, userTemplateKeys: mockUserTemplateKeys },
}));

vi.mock('../SpaceAgentsPage', () => ({
  SpaceAgentsPage: ({ spaceId, selectedHandle }: { spaceId: string; selectedHandle?: string }) => (
    <div data-testid="agents-page" data-space={spaceId} data-handle={selectedHandle ?? ''} />
  ),
}));

import { agentCreateRequest } from '../agent-create-request';
import { SpaceAgentsView } from '../SpaceAgentsView';

function makeTemplate(key: string): SpaceLongHorizonAgentTemplate {
  return {
    key,
    handle: key,
    displayName: key,
    description: '',
    toolPermissions: {},
  } as unknown as SpaceLongHorizonAgentTemplate;
}

describe('SpaceAgentsView', () => {
  beforeEach(() => {
    mockTemplates.value = [];
    mockUserTemplateKeys.value = new Set();
    agentCreateRequest.value = null;
  });

  it('passes the route props through to the agents page', () => {
    const { getByTestId } = render(<SpaceAgentsView spaceId="space-1" selectedHandle="alpha" />);

    expect(getByTestId('agents-page').getAttribute('data-space')).toBe('space-1');
    expect(getByTestId('agents-page').getAttribute('data-handle')).toBe('alpha');
  });

  it('renders the templates panel above the agents page', () => {
    mockTemplates.value = [makeTemplate('researcher.v1')];
    const { getByTestId, container } = render(<SpaceAgentsView spaceId="space-1" />);

    const panel = getByTestId('agent-template-count');
    const page = getByTestId('agents-page');
    expect(panel.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain('researcher.v1');
  });

  it('raises a create request for this Space when a template card is used', () => {
    mockTemplates.value = [makeTemplate('researcher.v1')];
    const { getByText } = render(<SpaceAgentsView spaceId="space-1" />);

    fireEvent.click(getByText('researcher.v1'));

    expect(agentCreateRequest.value).toEqual({
      spaceId: 'space-1',
      templateKey: 'researcher.v1',
    });
  });
});
