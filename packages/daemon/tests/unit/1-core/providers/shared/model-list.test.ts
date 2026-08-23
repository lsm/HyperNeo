import { describe, expect, it } from 'bun:test';
import {
  buildModelListUrl,
  extractAzureDeploymentModel,
  normalizeModelList,
} from '../../../../../src/lib/providers/shared/model-list';

describe('extractAzureDeploymentModel', () => {
  it('derives the model id from an Azure deployment URL', () => {
    expect(
      extractAzureDeploymentModel(
        'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
      )
    ).toEqual({ id: 'gpt-4o' });
  });

  it('derives the model id without the chat suffix', () => {
    expect(
      extractAzureDeploymentModel(
        'https://my-resource.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-08-01-preview'
      )
    ).toEqual({ id: 'gpt-4o' });
  });

  it('returns null for non-Azure base URLs', () => {
    expect(extractAzureDeploymentModel('https://api.openai.com/v1')).toBeNull();
  });
});

describe('buildModelListUrl', () => {
  it('appends /v1/models to a bare base URL', () => {
    expect(buildModelListUrl('https://api.example.com', 'openai-chat')).toBe(
      'https://api.example.com/v1/models'
    );
  });

  it('does not double-append /v1 when baseUrl already ends in /v1', () => {
    expect(buildModelListUrl('http://localhost:1234/v1', 'openai-chat')).toBe(
      'http://localhost:1234/v1/models'
    );
  });

  it('strips /v1/models from baseUrl before appending', () => {
    expect(buildModelListUrl('http://localhost:1234/v1/models', 'openai-chat')).toBe(
      'http://localhost:1234/v1/models'
    );
  });

  it('strips /chat/completions from baseUrl before appending', () => {
    expect(buildModelListUrl('http://localhost:1234/v1/chat/completions', 'openai-chat')).toBe(
      'http://localhost:1234/v1/models'
    );
  });

  it('strips /v1/messages and /v1/messages/count_tokens for anthropic-messages', () => {
    expect(
      buildModelListUrl('https://api.anthropic.com/v1/messages/count_tokens', 'anthropic-messages')
    ).toBe('https://api.anthropic.com/v1/models');
    expect(buildModelListUrl('https://api.anthropic.com/v1/messages', 'anthropic-messages')).toBe(
      'https://api.anthropic.com/v1/models'
    );
  });

  it('appends /api/tags for ollama-native', () => {
    expect(buildModelListUrl('http://localhost:11434', 'ollama-native')).toBe(
      'http://localhost:11434/api/tags'
    );
  });

  it('strips /api/chat and /api/tags from ollama baseUrl before appending', () => {
    expect(buildModelListUrl('http://localhost:11434/api/chat', 'ollama-native')).toBe(
      'http://localhost:11434/api/tags'
    );
    expect(buildModelListUrl('http://localhost:11434/api/tags', 'ollama-native')).toBe(
      'http://localhost:11434/api/tags'
    );
  });
});

describe('normalizeModelList', () => {
  it('normalizes the OpenAI /v1/models shape', () => {
    const result = normalizeModelList('openai-chat', {
      data: [
        { id: 'gpt-4', object: 'model' },
        { id: 'gpt-3.5-turbo' },
        { id: 'not-a-model', object: 'listing' },
        { object: 'model' },
        { id: '', object: 'model' },
      ],
    });
    expect(result).toEqual([{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }]);
  });

  it('normalizes the Anthropic /v1/models shape with display names', () => {
    const result = normalizeModelList('anthropic-messages', {
      data: [
        { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5' },
        { id: 'claude-opus-5', object: 'model' },
        { id: 'no-type-or-object' },
        { id: 'skipped', type: 'other' },
        { type: 'model' },
      ],
    });
    expect(result).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5' },
      { id: 'no-type-or-object' },
    ]);
  });

  it('normalizes the Ollama /api/tags shape', () => {
    const result = normalizeModelList('ollama-native', {
      models: [{ name: 'llama2' }, { model: 'codellama:7b' }, { name: '', model: '' }, {}],
    });
    expect(result).toEqual([{ id: 'llama2' }, { id: 'codellama:7b' }]);
  });

  it('returns an empty list for missing payloads', () => {
    expect(normalizeModelList('openai-chat', undefined)).toEqual([]);
    expect(normalizeModelList('ollama-native', {})).toEqual([]);
  });
});
