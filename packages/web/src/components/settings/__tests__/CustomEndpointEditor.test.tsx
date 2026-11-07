import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { EditorModal, existingToEditor, testCustomEndpoint } from '../CustomEndpointEditor.tsx';

const { probe, navigateToSettings } = vi.hoisted(() => ({
  probe: vi.fn(),
  navigateToSettings: vi.fn(),
}));
vi.mock('../../../lib/router.ts', () => ({ navigateToSettings }));
vi.mock('../../../lib/api-helpers.ts', () => ({ testCustomEndpointConnection: probe }));

describe('custom endpoint editor connection test', () => {
  beforeEach(() => {
    probe.mockReset().mockResolvedValue({ success: true, message: 'Reached daemon-only fixture' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch (CORS)')));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a successful daemon probe when the browser cannot access the endpoint', async () => {
    const state = existingToEditor({
      id: 'fixture',
      name: 'Fixture',
      baseUrl: 'http://daemon-only/v1',
      models: [{ id: 'fixture-model' }],
    });
    await expect(testCustomEndpoint(state)).resolves.toEqual({
      success: true,
      message: 'Reached daemon-only fixture',
    });
  });

  it('tests the unsaved Anthropic key, URL and header overrides', async () => {
    const state = existingToEditor({
      id: 'fixture',
      name: 'Fixture',
      type: 'anthropic-messages',
      baseUrl: 'http://old.invalid',
      models: [{ id: 'fixture-model' }],
    });
    state.baseUrl = ' http://daemon-only/v1/messages ';
    state.apiKey = ' synthetic-key ';
    state.headersText = 'anthropic-version: 2099-01-01\nX-Fixture: synthetic';
    await testCustomEndpoint(state);
    expect(probe).toHaveBeenCalledWith({
      baseUrl: 'http://daemon-only/v1/messages',
      type: 'anthropic-messages',
      apiKey: 'synthetic-key',
      headers: { 'anthropic-version': '2099-01-01', 'X-Fixture': 'synthetic' },
    });
  });

  it('refuses invalid header input without contacting the endpoint', async () => {
    const state = existingToEditor({
      id: 'fixture',
      name: 'Fixture',
      baseUrl: 'http://daemon-only',
      models: [{ id: 'fixture-model' }],
    });
    state.headersText = 'invalid header';
    expect((await testCustomEndpoint(state)).success).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('endpoint default mapping', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
  it('keeps the mapping in closed Advanced and links to the main default', () => {
    const state = existingToEditor({
      id: 'fixture',
      name: 'Fixture',
      baseUrl: 'http://example.test',
      models: [{ id: 'model-a' }],
      defaultModelId: 'model-a',
    });
    const onChange = vi.fn();
    render(
      <EditorModal
        state={state}
        existingIds={[]}
        onChange={onChange}
        onSave={vi.fn()}
        onClose={vi.fn()}
        saving={false}
        onTest={vi.fn()}
        testing={false}
        onFetchModels={vi.fn()}
        fetchingModels={false}
        fetchedModels={null}
        fetchModelsError={null}
        fetchedAt={null}
      />
    );
    const advanced = screen.getByText(/^Advanced/).closest('details');
    expect(advanced?.open).toBe(false);
    expect(advanced?.textContent).toContain('Endpoint adapter default model mapping');
    expect(
      (screen.getByLabelText('Endpoint adapter default model mapping') as HTMLSelectElement).value
    ).toBe('model-a');
    fireEvent.click(screen.getByText(/^Advanced/));
    fireEvent.click(screen.getByRole('button', { name: /Default Model/ }));
    expect(navigateToSettings).toHaveBeenCalledWith('harness');
    expect(onChange).not.toHaveBeenCalled();
  });
});
