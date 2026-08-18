export interface ProviderAuthStatus {
  id: string;
  displayName: string;
  isAuthenticated: boolean;
  method?: 'api_key' | 'oauth';
  expiresAt?: number;
  needsRefresh?: boolean;
  user?: {
    email?: string;
    name?: string;
  };
  error?: string;
}

export interface ProviderAuthRequest {
  providerId: string;
}

export interface ProviderAuthResponse {
  success: boolean;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  message?: string;
  error?: string;
}

export interface ProviderLogoutRequest {
  providerId: string;
}

export interface ProviderLogoutResponse {
  success: boolean;
  error?: string;
}

export interface ProviderRefreshRequest {
  providerId: string;
}

export interface ProviderRefreshResponse {
  success: boolean;
  error?: string;
}

export interface ListProviderAuthStatusResponse {
  providers: ProviderAuthStatus[];
}

export interface OAuthFlowData {
  type: 'redirect' | 'device';
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  message: string;
}
