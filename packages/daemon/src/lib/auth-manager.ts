import type { AuthStatus } from '@hyperneo/shared';
import type { Config } from '../config';
import type { Database } from '../storage/database';
import { EnvManager } from './env-manager';

export class AuthManager {
  private envManager: EnvManager;

  constructor(db?: Database, config?: Config, envPath?: string) {
    this.envManager = new EnvManager(envPath);
  }

  async initialize(): Promise<void> {
    // Nothing to initialize - all auth comes from env vars
  }

  async getAuthStatus(): Promise<AuthStatus> {
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

    const apiKey = this.envManager.getApiKey();
    if (apiKey) {
      return {
        method: 'api_key',
        isAuthenticated: true,
        source: 'env',
      };
    }

    return {
      method: 'none',
      isAuthenticated: false,
      source: 'env',
    };
  }

  async getCurrentApiKey(): Promise<string | null> {
    const oauthToken = this.envManager.getOAuthToken();
    if (oauthToken) {
      return oauthToken;
    }

    const apiKey = this.envManager.getApiKey();
    if (apiKey) {
      return apiKey;
    }

    return null;
  }
}
