import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';

const mockModels = [
  {
    id: 'claude-sonnet-4-6',
    display_name: 'Claude Sonnet 4.6',
    description: '',
    provider: 'anthropic',
  },
  {
    id: 'glm-5.3[1m]',
    display_name: 'GLM-5.3',
    description: 'GLM-5.3 · 1M context window',
    alias: 'glm-5.3',
    provider: 'glm',
    contextWindow: 1000000,
  },
  {
    id: 'glm-5.3-flash[1m]',
    display_name: 'GLM-5.3-Flash',
    description: 'GLM-5.3-Flash · 1M context window',
    alias: 'glm-5.3-flash',
    provider: 'glm',
    contextWindow: 1000000,
  },
  {
    id: 'glm-4.6',
    display_name: 'glm-4.6',
    description: 'glm-4.6 via Z.ai',
    alias: 'glm-4.6',
    provider: 'glm',
    contextWindow: 200000,
  },
];

const mockHub = {
  request: vi.fn(async (method: string) => {
    if (method === 'models.list') {
      return { models: mockModels };
    }
    return {};
  }),
};

vi.mock('../../../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: () => Promise.resolve(mockHub),
    getHubIfConnected: () => mockHub,
  },
}));

import { WorkflowModelSelect } from '../WorkflowModelSelect';

afterEach(() => {
  cleanup();
});

function encodeModelValue(provider: string, id: string): string {
  return encodeURIComponent(JSON.stringify([provider, id]));
}

describe('WorkflowModelSelect', () => {
  describe('Z.ai provider parity', () => {
    it('renders Z.ai models under a Z.ai optgroup', async () => {
      const { getByTestId } = render(
        <WorkflowModelSelect value={undefined} onChange={vi.fn()} testId="glm-model-select" />
      );
      const select = getByTestId('glm-model-select') as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

      const glmGroup = select.querySelector('optgroup[label="Z.ai"]');
      expect(glmGroup).toBeTruthy();
      const glmOptions = Array.from(glmGroup!.querySelectorAll('option')).map((o) => o.textContent);
      expect(glmOptions).toContain('GLM-5.3 (glm-5.3[1m])');
      expect(glmOptions).toContain('GLM-5.3-Flash (glm-5.3-flash[1m])');
      expect(glmOptions).toContain('glm-4.6 (glm-4.6)');
    });

    it('selects a Z.ai model and reports the glm provider', async () => {
      const onChange = vi.fn();
      const { getByTestId } = render(
        <WorkflowModelSelect value={undefined} onChange={onChange} testId="glm-model-select" />
      );
      const select = getByTestId('glm-model-select') as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

      select.value = encodeModelValue('glm', 'glm-5.3-flash[1m]');
      fireEvent.change(select);

      expect(onChange).toHaveBeenCalledWith('glm-5.3-flash[1m]', {
        provider: 'glm',
        modelId: 'glm-5.3-flash[1m]',
      });
    });

    it('keeps [1m]-suffixed Z.ai model ids intact through selection', async () => {
      const onChange = vi.fn();
      const { getByTestId } = render(
        <WorkflowModelSelect value={undefined} onChange={onChange} testId="glm-model-select" />
      );
      const select = getByTestId('glm-model-select') as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

      for (const modelId of ['glm-5.3[1m]', 'glm-5.3-flash[1m]']) {
        select.value = encodeModelValue('glm', modelId);
        fireEvent.change(select);
        expect(onChange).toHaveBeenLastCalledWith(modelId, {
          provider: 'glm',
          modelId,
        });
      }
    });

    it('shows a provider-qualified Z.ai value as selected', async () => {
      const { getByTestId } = render(
        <WorkflowModelSelect
          value="glm-5.3-flash[1m]"
          provider="glm"
          onChange={vi.fn()}
          testId="glm-model-select"
        />
      );
      const select = getByTestId('glm-model-select') as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

      expect(select.value).toBe(encodeModelValue('glm', 'glm-5.3-flash[1m]'));
    });

    it('backfills a providerless Z.ai value from the loaded list', async () => {
      const { getByTestId } = render(
        <WorkflowModelSelect value="glm-4.6" onChange={vi.fn()} testId="glm-model-select" />
      );
      const select = getByTestId('glm-model-select') as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

      expect(select.value).toBe(encodeModelValue('glm', 'glm-4.6'));
    });

    it('clears the override when the empty option is chosen', async () => {
      const onChange = vi.fn();
      const { getByTestId } = render(
        <WorkflowModelSelect
          value="glm-4.6"
          provider="glm"
          onChange={onChange}
          testId="glm-model-select"
        />
      );
      const select = getByTestId('glm-model-select') as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1));

      select.value = '';
      fireEvent.change(select);

      expect(onChange).toHaveBeenCalledWith(undefined);
    });
  });
});
