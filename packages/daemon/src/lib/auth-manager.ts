import type { AuthStatus } from '@hyperneo/shared';
import type { Config } from '../config.ts';
import type { Database } from '../storage/database.ts';
import { EnvManager } from './env-manager.ts';
import { providerEnvCoordinator } from './providers/provider-env-enrollment.ts';

export class AuthManager {
  private envManager: EnvManager;

  constructor(db?: Database, config?: Config, envPath?: string) {
    this.envManager = new EnvManager(envPath);
  }

  async initialize(): Promise<void> {}

  async getAuthStatus(): Promise<AuthStatus> {
    return providerEnvCoordinator.runWithLease('auth-manager', () => {
      const oauthToken = this.envManager.getOAuthToken();
      if (oauthToken) {
        return {
          method: 'oauth_token',
          isAuthenticated: true,
          source: 'env',
          user: {},
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
    });
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
