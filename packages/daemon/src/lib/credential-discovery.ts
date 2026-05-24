import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

export interface DiscoveryResult {
  credentialSource: 'env' | 'credentials-file' | 'keychain' | 'settings-json' | 'none';
  settingsEnvApplied: number; // count of env vars injected from settings.json
  errors: string[]; // non-fatal issues encountered
}

export interface DiscoveryOptions {
  keychainReader?: () => string; // Returns raw JSON string from keychain, throws on failure
  platformName?: string; // Override platform detection (for testing)
}

/**
 * Discover Claude Code credentials and inject them into process.env.
 * Runs once at daemon startup to enrich the environment before any other code reads it.
 * Never overwrites existing env vars - explicit config always wins.
 */
export function discoverCredentials(
  claudeDir?: string,
  options?: DiscoveryOptions
): DiscoveryResult {
  const errors: string[] = [];
  let credentialSource: DiscoveryResult['credentialSource'] = 'none';
  let settingsEnvApplied = 0;

  const claudeBase = claudeDir || join(homedir(), '.claude');

  try {
    // Step 1: Check if credentials already exist in process.env
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN;

    if (hasApiKey && hasOAuthToken && hasAuthToken) {
      // All credentials already present, skip discovery
      credentialSource = 'env';
    } else {
      // Step 2: Try reading ~/.claude/.credentials.json
      if (!hasOAuthToken) {
        try {
          const credentialsPath = join(claudeBase, '.credentials.json');
          if (existsSync(credentialsPath)) {
            const credentialsContent = readFileSync(credentialsPath, 'utf8');
            const credentials = JSON.parse(credentialsContent);

            if (credentials?.claudeAiOauth?.accessToken) {
              process.env.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeAiOauth.accessToken;
              credentialSource = 'credentials-file';
            }
          }
        } catch (err) {
          errors.push(
            `Failed to read ~/.claude/.credentials.json: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Step 3: If still no OAuth token AND on macOS, try keychain
      if (
        !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
        (options?.platformName ?? platform()) === 'darwin'
      ) {
        try {
          const keychainOutput = options?.keychainReader
            ? options.keychainReader()
            : execSync('security find-generic-password -s "Claude Code-credentials" -w', {
                timeout: 5000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr
              });

          const keychainData = JSON.parse(
            typeof keychainOutput === 'string' ? keychainOutput.trim() : keychainOutput
          );
          if (keychainData?.claudeAiOauth?.accessToken) {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = keychainData.claudeAiOauth.accessToken;
            credentialSource = 'keychain';
          }
        } catch {
          // Keychain access denied or command failed - silently continue
          // This is expected if the user hasn't granted keychain access
        }
      }
    }

    // Step 4: ALWAYS read ~/.claude/settings.json and apply env vars
    try {
      const settingsPath = join(claudeBase, 'settings.json');
      if (existsSync(settingsPath)) {
        const settingsContent = readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(settingsContent);

        if (settings?.env && typeof settings.env === 'object') {
          for (const [key, value] of Object.entries(settings.env)) {
            // Only set if not already present
            if (!process.env[key]) {
              process.env[key] = String(value);
              settingsEnvApplied++;
            }
          }

          // If we discovered credentials from settings.json and no other source was found
          if (settingsEnvApplied > 0 && credentialSource === 'none') {
            credentialSource = 'settings-json';
          }
        }
      }
    } catch (err) {
      errors.push(
        `Failed to read ~/.claude/settings.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } catch (err) {
    // Catch-all for unexpected errors
    errors.push(
      `Unexpected error during credential discovery: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    credentialSource,
    settingsEnvApplied,
    errors,
  };
}
