import type { Database } from 'bun:sqlite';
import type { ProviderCredentials } from '@neokai/shared/provider';
import {
  createCredentialStore,
  credentialService,
  type CredentialStore,
} from './credential-store.js';

const DEFAULT_ACCOUNT = 'default';

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  glm: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
  kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY'],
  'anthropic-codex': ['OPENAI_API_KEY'],
  'anthropic-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN'],
};

export class ProviderCredentialManager {
  static create(db: Database, env: NodeJS.ProcessEnv = process.env): ProviderCredentialManager {
    return new ProviderCredentialManager(createCredentialStore(db), db, env);
  }

  constructor(
    private readonly store: CredentialStore,
    private readonly db: Database,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async storeApiKey(providerId: string, apiKey: string): Promise<void> {
    const credentials: ProviderCredentials = { type: 'api_key', apiKey };
    await this.store.set(
      credentialService(providerId),
      DEFAULT_ACCOUNT,
      JSON.stringify(credentials)
    );
    this.updateProviderAuth(providerId, 'api_key', 'healthy');
  }

  async storeOAuthTokens(
    providerId: string,
    tokens: ProviderCredentials | Record<string, unknown>
  ): Promise<void> {
    const credentials = normalizeOAuthCredentials(tokens);
    await this.store.set(
      credentialService(providerId),
      DEFAULT_ACCOUNT,
      JSON.stringify(credentials)
    );
    this.updateProviderAuth(providerId, 'oauth', 'healthy');
  }

  async getCredentials(providerId: string): Promise<ProviderCredentials | null> {
    const data = await this.store.get(credentialService(providerId), DEFAULT_ACCOUNT);
    if (!data) return null;
    return JSON.parse(data) as ProviderCredentials;
  }

  async removeCredentials(providerId: string): Promise<void> {
    await this.store.delete(credentialService(providerId), DEFAULT_ACCOUNT);
    this.updateProviderAuth(providerId, 'none', 'unknown');
  }

  async migrateFromEnv(providerId: string): Promise<boolean> {
    const apiKey = this.getEnvApiKey(providerId);
    if (!apiKey) return false;
    await this.storeApiKey(providerId, apiKey);
    return true;
  }

  async listCredentialProviderIds(): Promise<string[]> {
    const services = await this.store.listServices('neokai.provider.');
    return services.map((service) => service.replace(/^neokai\.provider\./, ''));
  }

  markProviderHealth(providerId: string, healthStatus: 'unknown' | 'healthy' | 'unhealthy'): void {
    if (!this.hasProvidersTable()) return;
    this.db
      .prepare(
        `UPDATE providers
         SET health_status = ?, last_health_check_at = ?, updated_at = ?
         WHERE provider_id = ? OR id = ?`
      )
      .run(healthStatus, Date.now(), Date.now(), providerId, providerId);
  }

  private getEnvApiKey(providerId: string): string | undefined {
    for (const key of PROVIDER_ENV_KEYS[providerId] ?? []) {
      const value = this.env[key]?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private updateProviderAuth(
    providerId: string,
    authType: 'api_key' | 'oauth' | 'none',
    healthStatus: 'unknown' | 'healthy' | 'unhealthy'
  ): void {
    if (!this.hasProvidersTable()) return;
    this.db
      .prepare(
        `UPDATE providers
         SET auth_type = ?, health_status = ?, updated_at = ?
         WHERE provider_id = ? OR id = ?`
      )
      .run(authType, healthStatus, Date.now(), providerId, providerId);
  }

  private hasProvidersTable(): boolean {
    const row = this.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='providers'"
      )
      .get();
    return row !== null;
  }
}

function normalizeOAuthCredentials(
  tokens: ProviderCredentials | Record<string, unknown>
): ProviderCredentials {
  if ('type' in tokens && tokens.type === 'oauth') return tokens as ProviderCredentials;
  const tokenRecord = tokens as Record<string, unknown>;
  return {
    type: 'oauth',
    accessToken: stringValue(tokenRecord.accessToken) ?? stringValue(tokenRecord.access_token),
    refreshToken: stringValue(tokenRecord.refreshToken) ?? stringValue(tokenRecord.refresh_token),
    expiresAt:
      numberValue(tokenRecord.expiresAt) ??
      numberValue(tokenRecord.expires_at) ??
      numberValue(tokenRecord.expires),
    raw: tokenRecord,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
