export class EnvManager {
  constructor(_envPath?: string) {}

  getApiKey(): string | undefined {
    return (
      process.env.ANTHROPIC_API_KEY ||
      process.env.GLM_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN
    );
  }

  getOAuthToken(): string | undefined {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  hasCredentials(): boolean {
    return !!(
      process.env.ANTHROPIC_API_KEY ||
      process.env.GLM_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN
    );
  }
}
