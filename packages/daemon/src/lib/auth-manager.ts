import type { AuthStatus } from '@hyperneo/shared';
import type { Config } from '../config';
import type { Database } from '../storage/database';
import { EnvManager } from './env-manager';

/**
 * AuthManager - Central authentication coordinator
 *
 * Manages authentication via environment variables only.
 * Supports both API keys and OAuth tokens provided as env vars.
 *
 * IMPORTANT: All credentials must be provided via environment variables.
 * No runtime credential modification is supported.
 */
export class AuthManager {
  private envManager: EnvManager;

  constructor(db?: Database, config?: Config, envPath?: string) {
    // db and config kept for backward compatibility but not used
    this.envManager = new EnvManager(envPath);
  }

  /**
   * Initialize auth manager
   */
  async initialize(): Promise<void> {
    // Nothing to initialize - all auth comes from env vars
  }

  /**
   * Get current authentication status
   */
  async getAuthStatus(): Promise<AuthStatus> {
    // Check for OAuth token in env (highest priority)
    const oauthToken = this.envManager.getOAuthToken();
    if (oauthToken) {
      return {
        method: 'oauth_token',
        isAuthenticated: true,
        source: 'env',
        user: {
          // Long-lived token from env (valid for 1 year)
        },
      };
    }

    // Check for API key in env
    const apiKey = this.envManager.getApiKey();
    if (apiKey) {
      return {
        method: 'api_key',
        isAuthenticated: true,
        source: 'env',
      };
    }

    // No authentication configured
    return {
      method: 'none',
      isAuthenticated: false,
      source: 'env',
    };
  }

  /**
   * Get current API key (for use in agent sessions)
   */
  async getCurrentApiKey(): Promise<string | null> {
    // Priority 1: OAuth token from env
    const oauthToken = this.envManager.getOAuthToken();
    if (oauthToken) {
      return oauthToken;
    }

    // Priority 2: API key from env
    const apiKey = this.envManager.getApiKey();
    if (apiKey) {
      return apiKey;
    }

    return null;
  }
}
