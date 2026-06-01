/**
 * Provider Sync
 *
 * Bridges the providers table ↔ ProviderRegistry at runtime.
 * - syncProviderToRegistry: creates/updates a Provider instance from a DB record
 * - syncAllProviders: startup sweep that registers all enabled rows
 * - removeProviderFromRegistry: shutdown + unregister
 */

import type { ProviderRecord, CustomEndpointConfig } from '@neokai/shared';
import type { ProviderCredentials } from '@neokai/shared/provider';
import { getProviderRegistry } from './registry.js';
import { initializeProviders, registerBuiltInProvider } from './factory.js';
import { CustomEndpointProvider, customProviderIdFor } from './custom-endpoint-provider.js';
import { Logger } from '../logger.js';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.js';

const logger = new Logger('providers:sync');

// ---------------------------------------------------------------------------
// Sync a single DB record into the registry
// ---------------------------------------------------------------------------

export async function syncProviderToRegistry(
  record: ProviderRecord,
  credentials?: ProviderCredentials | null
): Promise<void> {
  const registry = getProviderRegistry();

  // Built-in providers are already registered by initializeProviders().
  // If one was unregistered (e.g., user deleted and is re-adding it),
  // restore only that provider instead of re-creating every core provider.
  if (record.kind === 'built_in') {
    await registerBuiltInProvider(registry, record.providerId);
    const provider = registry.get(record.providerId);
    if (provider?.setCredentials && credentials) {
      // For providers that manage their own auth state (e.g. Codex), skip
      // applying stale credential-store rows when the provider's own state
      // says it has been logged out. This prevents resurrecting credentials
      // that were cleared by a failed runtime refresh.
      if (provider.logout && provider.getCredentials) {
        const own = await provider.getCredentials();
        if (!own) {
          logger.info(`Skipping stale stored credentials for ${record.providerId}`);
          return;
        }
      }
      provider.setCredentials(credentials);
      logger.info(`Applied credentials to built-in provider ${record.providerId}`);
    }
    return;
  }

  // Custom endpoint: create a new CustomEndpointProvider instance.
  if (record.kind === 'custom_endpoint') {
    if (!record.customEndpointConfigJson) {
      logger.warn(`Custom endpoint provider ${record.providerId} has no config; skipping`);
      return;
    }

    let config: CustomEndpointConfig;
    try {
      config = JSON.parse(record.customEndpointConfigJson) as CustomEndpointConfig;
    } catch (err) {
      logger.warn(`Failed to parse custom endpoint config for ${record.providerId}:`, err);
      return;
    }

    // If baseUrl was overridden in the provider record, merge it into the config.
    if (record.baseUrl) {
      config = { ...config, baseUrl: record.baseUrl };
    }

    const providerId = customProviderIdFor(config.id);

    // Shutdown existing instance if present.
    const existing = registry.get(providerId);
    if (existing?.shutdown) {
      try {
        await existing.shutdown();
      } catch (err) {
        logger.warn(`Failed to shut down custom endpoint provider ${providerId}:`, err);
      }
    }
    if (existing) {
      registry.unregister(providerId);
    }

    try {
      const provider = new CustomEndpointProvider(config);
      registry.register(provider);
      logger.info(`Registered custom endpoint provider ${providerId}`);
    } catch (err) {
      logger.warn(`Failed to register custom endpoint provider ${providerId}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Startup: sync all enabled provider records
// ---------------------------------------------------------------------------

export async function syncAllProviders(
  listEnabled: () => ProviderRecord[],
  credentialManager: ProviderCredentialManager
): Promise<void> {
  // Ensure built-ins are registered first.
  initializeProviders();

  const records = listEnabled();
  for (const record of records) {
    try {
      const credentials = await credentialManager.getCredentials(record.providerId);
      await syncProviderToRegistry(record, credentials);
    } catch (err) {
      logger.warn(`Failed to sync provider ${record.providerId}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Remove a provider from the registry
// ---------------------------------------------------------------------------

export async function removeProviderFromRegistry(providerId: string): Promise<void> {
  const registry = getProviderRegistry();
  const provider = registry.get(providerId);
  if (!provider) return;

  if (provider.shutdown) {
    try {
      await provider.shutdown();
    } catch (err) {
      logger.warn(`Failed to shut down provider ${providerId}:`, err);
    }
  }

  registry.unregister(providerId);
  logger.info(`Unregistered provider ${providerId}`);
}
