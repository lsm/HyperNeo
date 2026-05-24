/**
 * Provider Authentication Types
 *
 * Types for provider OAuth/API key authentication flows.
 * Used by both daemon (backend) and web (frontend) packages.
 */

/**
 * Authentication status for a single provider
 */
export interface ProviderAuthStatus {
  /** Provider identifier */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Whether the provider is authenticated */
  isAuthenticated: boolean;
  /** Authentication method used */
  method?: 'api_key' | 'oauth';
  /** Token expiration timestamp (Unix ms) */
  expiresAt?: number;
  /** Whether token needs refresh */
  needsRefresh?: boolean;
  /** User information (if available) */
  user?: {
    email?: string;
    name?: string;
  };
  /** Error message if authentication failed */
  error?: string;
}

/**
 * Request to initiate authentication for a provider
 */
export interface ProviderAuthRequest {
  /** Provider identifier */
  providerId: string;
}

/**
 * Response from initiating authentication
 */
export interface ProviderAuthResponse {
  /** Whether the auth initiation was successful */
  success: boolean;
  /** URL to open in browser (for OAuth redirect flow like OpenAI) */
  authUrl?: string;
  /** User code to display (for device flow like GitHub Copilot) */
  userCode?: string;
  /** Verification URL for device flow */
  verificationUri?: string;
  /** Human-readable message */
  message?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Request to logout from a provider
 */
export interface ProviderLogoutRequest {
  /** Provider identifier */
  providerId: string;
}

/**
 * Request to refresh token for a provider
 */
export interface ProviderRefreshRequest {
  /** Provider identifier */
  providerId: string;
}

/**
 * Response from refreshing provider token
 */
export interface ProviderRefreshResponse {
  /** Whether the refresh was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Response from listing provider auth statuses
 */
export interface ListProviderAuthStatusResponse {
  /** List of provider authentication statuses */
  providers: ProviderAuthStatus[];
}

/**
 * Internal type for OAuth flow data
 * Used by providers to return flow-specific data
 */
export interface OAuthFlowData {
  /** Flow type */
  type: 'redirect' | 'device';
  /** For redirect flow: URL to open in browser */
  authUrl?: string;
  /** For device flow: user code to display */
  userCode?: string;
  /** For device flow: verification URL */
  verificationUri?: string;
  /** Human-readable message */
  message: string;
}
