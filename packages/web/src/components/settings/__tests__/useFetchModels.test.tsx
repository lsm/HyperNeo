import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/preact';
import { useFetchModels } from '../useFetchModels.ts';
import type { EditorState } from '../CustomEndpointEditor.tsx';

const { mockListCustomEndpointModels } = vi.hoisted(() => ({
  mockListCustomEndpointModels: vi.fn(),
}));

vi.mock('../../../lib/api-helpers.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/api-helpers.ts')>();
  return {
    ...original,
    listCustomEndpointModels: mockListCustomEndpointModels,
  };
});

const baseEditor: EditorState = {
  mode: 'create',
  id: 'test-endpoint',
  type: 'openai-chat',
  name: 'Test Endpoint',
  baseUrl: '  http://localhost:1234/v1  ',
  apiKey: ' sk-test ',
  headersText: '',
  defaultModelId: '',
  models: [],
};

function HookHost({ editor }: { editor: EditorState }) {
  const { handleFetchModels } = useFetchModels(editor);
  return (
    <button type="button" onClick={() => handleFetchModels()}>
      fetch
    </button>
  );
}

describe('useFetchModels', () => {
  beforeEach(() => {
    mockListCustomEndpointModels.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('requests models with force so explicit refreshes bypass the 30s cache', async () => {
    mockListCustomEndpointModels.mockResolvedValue({
      models: [{ id: 'gpt-4' }],
      fromCache: false,
    });

    const { container } = render(<HookHost editor={baseEditor} />);
    fireEvent.click(container.querySelector('button')!);

    await waitFor(() => {
      expect(mockListCustomEndpointModels).toHaveBeenCalledTimes(1);
    });
    expect(mockListCustomEndpointModels).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:1234/v1',
      type: 'openai-chat',
      apiKey: 'sk-test',
      headers: undefined,
      force: true,
    });
  });
});
