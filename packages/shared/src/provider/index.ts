export type {
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ProviderCredentials,
  ProviderFailureErrorKind,
  ProviderId,
  ProviderInfo,
  ProviderSdkConfig,
  ProviderSessionConfig,
  ModelTier,
  ProviderAuthStatusInfo,
  ProviderOAuthFlowData,
  CuratedModel,
  ListRemoteModelsOptions,
} from './types.js';

export type {
  ProviderAuthStatus,
  ProviderAuthRequest,
  ProviderAuthResponse,
  ProviderCallbackRelayRequest,
  ProviderCallbackRelayResponse,
  ProviderLogoutRequest,
  ProviderLogoutResponse,
  ProviderRefreshRequest,
  ProviderRefreshResponse,
  ListProviderAuthStatusResponse,
  OAuthFlowData,
} from './auth-types.js';

export type {
  AnthropicErrorType,
  PromptTooLongMatch,
  ProviderErrorAction,
  ProviderErrorKind,
  ProviderErrorTaxonomyEntry,
} from './error-taxonomy.js';

export {
  GLM_RATE_LIMIT_CODE,
  GLM_TRANSIENT_BODY_SUBSTRINGS,
  HTTP_4XX_STATUS_RE,
  HTTP_5XX_STATUS_RE,
  OVERLOAD_MESSAGE_PATTERN,
  PROMPT_TOO_LONG_RE,
  PROVIDER_ERROR_TAXONOMY,
  RATE_LIMIT_MESSAGE_PATTERN,
  RETRYABLE_PROVIDER_ERROR_TEXT,
  TERMINAL_PROVIDER_ERROR_TEXT,
  TRANSIENT_CONNECTION_ERROR_REGEXES,
  TRANSIENT_CONNECTION_ERROR_SUBSTRINGS,
  TRANSIENT_OVERLOAD_CODES,
  TRANSIENT_RATE_LIMIT_CODES,
  actionForProviderErrorKind,
  anthropicErrorTypeForHttpStatus,
  isRetryableProviderError,
  looseTextSubstringToRegex,
  matchPromptTooLong,
  providerErrorKindForHttpStatus,
} from './error-taxonomy.js';

export const PROVIDER_MODEL_LOAD_TIMEOUT_MS = 30_000;
export const MODEL_LIST_REQUEST_TIMEOUT_MS = PROVIDER_MODEL_LOAD_TIMEOUT_MS * 2 + 5_000;
