import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existingToEditor, testCustomEndpoint } from '../CustomEndpointEditor.tsx';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
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
