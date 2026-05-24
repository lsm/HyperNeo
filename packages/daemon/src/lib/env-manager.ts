/**
 * EnvManager - Read-only access to environment variables
 *
 * Provides a simple interface to read authentication credentials
 * from environment variables. Does NOT support runtime modification.
 */
export class EnvManager {
  constructor(_envPath?: string) {
    // _envPath is kept for backward compatibility with tests but not used
    // All credentials are read from process.env only
  }

  /**
   * Get current API key from environment
   * Supports ANTHROPIC_API_KEY, GLM_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, and ANTHROPIC_AUTH_TOKEN
   */
  getApiKey(): string | undefined {
    return (
      process.env.ANTHROPIC_API_KEY ||
      process.env.GLM_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN
    );
  }

  /**
   * Get current OAuth token from environment
   */
  getOAuthToken(): string | undefined {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  /**
   * Check if any credentials are configured
   */
  hasCredentials(): boolean {
    return !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.GLM_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN
    );
  }
}
