import type {
  CustomEndpointConfig,
  CustomEndpointType,
  CustomEndpointModelCapabilities,
} from '@hyperneo/shared';

export interface CustomEndpointPreset {
  key: string;
  label: string;
  description: string;
  apiKeyRequired: boolean;
  docsUrl?: string;
  template: Omit<CustomEndpointConfig, 'models'> & {
    models?: CustomEndpointConfig['models'];
  };
  defaultModelCapabilities?: Partial<CustomEndpointModelCapabilities>;
}

const TYPE_OPENAI: CustomEndpointType = 'openai-chat';
const TYPE_OLLAMA: CustomEndpointType = 'ollama-native';
const TYPE_ANTHROPIC: CustomEndpointType = 'anthropic-messages';

export const CUSTOM_ENDPOINT_PRESETS: CustomEndpointPreset[] = [
  {
    key: 'blank',
    label: 'Blank — custom OpenAI-compatible',
    description: 'Start from scratch (OpenAI Chat Completions).',
    apiKeyRequired: false,
    template: {
      id: 'custom',
      type: TYPE_OPENAI,
      name: 'Custom Endpoint',
      baseUrl: '',
    },
  },
  {
    key: 'ollama',
    label: 'Ollama (local)',
    description: 'Local Ollama daemon, native /api/chat surface.',
    apiKeyRequired: false,
    docsUrl: 'https://github.com/ollama/ollama',
    template: {
      id: 'ollama-local',
      type: TYPE_OLLAMA,
      name: 'Ollama (local)',
      baseUrl: 'http://localhost:11434',
    },
    defaultModelCapabilities: {
      thinking: false,
      caching: false,
      vision: false,
      toolUse: true,
    },
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    description: 'Aggregator API — key required.',
    apiKeyRequired: true,
    docsUrl: 'https://openrouter.ai/docs',
    template: {
      id: 'openrouter',
      type: TYPE_OPENAI,
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    },
    defaultModelCapabilities: {
      streamUsage: true,
    },
  },
  {
    key: 'lmstudio',
    label: 'LM Studio (local)',
    description: 'Local LM Studio OpenAI-compatible server.',
    apiKeyRequired: false,
    docsUrl: 'https://lmstudio.ai/docs/local-server',
    template: {
      id: 'lmstudio',
      type: TYPE_OPENAI,
      name: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
    },
  },
  {
    key: 'litellm',
    label: 'LiteLLM proxy',
    description: 'Self-hosted LiteLLM proxy — baseUrl + optional key.',
    apiKeyRequired: false,
    docsUrl: 'https://docs.litellm.ai/docs/proxy/quick_start',
    template: {
      id: 'litellm',
      type: TYPE_OPENAI,
      name: 'LiteLLM',
      baseUrl: '',
    },
    defaultModelCapabilities: {
      streamUsage: true,
    },
  },
  {
    key: 'anthropic-shim',
    label: 'Anthropic-compatible proxy',
    description: 'Custom Anthropic Messages API passthrough.',
    apiKeyRequired: true,
    template: {
      id: 'anthropic-shim',
      type: TYPE_ANTHROPIC,
      name: 'Anthropic Proxy',
      baseUrl: '',
    },
  },
];

export function findPreset(key: string): CustomEndpointPreset | undefined {
  return CUSTOM_ENDPOINT_PRESETS.find((p) => p.key === key);
}
