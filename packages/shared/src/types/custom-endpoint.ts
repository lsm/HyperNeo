import { AUTO_COMPACT_PERCENT_DEFAULT } from '../models.js';

export type CustomEndpointType = 'openai-chat' | 'anthropic-messages' | 'ollama-native';

export const DEFAULT_CUSTOM_ENDPOINT_TYPE: CustomEndpointType = 'openai-chat';

export interface CustomEndpointModelCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  thinking: boolean;
  caching: boolean;
  maxContextTokens: number;
  autoCompactPercent?: number;
  streamUsage: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
}

export interface CustomEndpointModel {
  id: string;
  name?: string;
  providerModelId?: string;
  capabilities?: Partial<CustomEndpointModelCapabilities>;
}

export interface CustomEndpointConfig {
  id: string;
  type?: CustomEndpointType;
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: CustomEndpointModel[];
  defaultModelId?: string;
}

export const DEFAULT_CUSTOM_ENDPOINT_CAPABILITIES: CustomEndpointModelCapabilities = {
  streaming: true,
  toolUse: true,
  vision: false,
  thinking: false,
  caching: false,
  maxContextTokens: 128000,
  autoCompactPercent: AUTO_COMPACT_PERCENT_DEFAULT,
  streamUsage: false,
};

export const CUSTOM_ENDPOINT_TYPE_CAPABILITY_DEFAULTS: Record<
  CustomEndpointType,
  Partial<CustomEndpointModelCapabilities>
> = {
  'openai-chat': {},
  'anthropic-messages': {
    toolUse: true,
    vision: true,
    thinking: true,
    caching: true,
  },
  'ollama-native': {
    toolUse: true,
    vision: false,
    thinking: false,
    caching: false,
  },
};

export function resolveCustomEndpointType(config: CustomEndpointConfig): CustomEndpointType {
  return config.type ?? DEFAULT_CUSTOM_ENDPOINT_TYPE;
}
