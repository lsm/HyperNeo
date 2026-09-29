// @ts-nocheck

import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowModelSelect } from '../WorkflowModelSelect';

const mockGetHub = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: () => mockGetHub(),
  },
}));

function makeHub(models: Array<Record<string, unknown>>) {
  return {
    request: vi.fn().mockImplementation((method: string) => {
      if (method === 'models.list') {
        return Promise.resolve({ models });
      }
      return Promise.resolve(null);
    }),
  };
}

describe('WorkflowModelSelect', () => {
  beforeEach(() => {
    cleanup();
    mockGetHub.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('disables unavailable models and labels them', async () => {
    mockGetHub.mockResolvedValue(
      makeHub([
        {
          id: 'gpt-6-astra',
          display_name: 'GPT-6-Astra',
          description: '',
          provider: 'anthropic-codex',
        },
        {
          id: 'gpt-5.3-codex',
          display_name: 'GPT-5.3 Codex',
          description: '',
          provider: 'anthropic-codex',
          available: false,
        },
      ])
    );

    const { container } = render(
      <WorkflowModelSelect testId="workflow-model" onChange={() => {}} />
    );

    await waitFor(() => {
      expect(container.querySelector('select option[value=""]')).toBeTruthy();
    });
    const options = [...container.querySelectorAll('option')];
    const unavailable = options.find((option) => option.textContent?.includes('gpt-5.3-codex'));
    const available = options.find((option) => option.textContent?.includes('gpt-6-astra'));
    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.textContent).toContain('unavailable');
    expect(available?.disabled).toBe(false);
  });
});
