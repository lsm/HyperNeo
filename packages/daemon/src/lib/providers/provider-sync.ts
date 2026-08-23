import type { ProviderRecord, CustomEndpointConfig } from '@hyperneo/shared';
import type { CuratedModel, ProviderCredentials } from '@hyperneo/shared/provider';
import { getProviderRegistry } from './registry.js';
import { initializeProviders, registerBuiltInProvider } from './factory.js';
import { AcpProvider } from './acp-provider.js';
import { CustomEndpointProvider, customProviderIdFor } from './custom-endpoint-provider.js';
import { Logger } from '../logger.js';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.js';
import { resolveKimiRegion } from './kimi-provider.js';

const logger = new Logger('providers:sync');

export function parseProviderConfig(configJson: string | undefined): {
  command?: string;
  models?: CuratedModel[];
} {
  if (!configJson) return {};
  try {
    const parsed = JSON.parse(configJson) as { command?: unknown; models?: unknown };
    const command = typeof parsed.command === 'string' ? parsed.command : undefined;
    const models = Array.isArray(parsed.models)
      ? parsed.models
          .filter(
            (model: unknown): model is CuratedModel =>
              !!model && typeof model === 'object' && typeof (model as CuratedModel).id === 'string'
          )
          .map((model) => ({
            id: model.id,
            name: typeof model.name === 'string' ? model.name : undefined,
          }))
      : undefined;
    return { command, models };
  } catch {
    return {};
  }
}

export async function syncProviderToRegistry(
  record: ProviderRecord,
  credentials?: ProviderCredentials | null,
  isStartupSync = false
): Promise<void> {
  const registry = getProviderRegistry();

  if (record.kind === 'built_in') {
    await registerBuiltInProvider(registry, record.providerId);
    const provider = registry.get(record.providerId);
    if (provider && provider.id === 'kimi' && 'setDefaultRegion' in provider) {
      let parsedRegion: unknown;
      try {
        parsedRegion = record.configJson ? JSON.parse(record.configJson).region : undefined;
      } catch {
        parsedRegion = undefined;
      }
      const region = resolveKimiRegion(parsedRegion);
      (provider as { setDefaultRegion: (r: 'china' | 'global') => void }).setDefaultRegion(region);
      logger.info(`Kimi provider region set to '${region}'`);
    }
    const { command, models } = parseProviderConfig(record.configJson);
    if (provider instanceof AcpProvider) {
      provider.setAcpCommand(command);
      logger.info(`ACP provider command ${command ? 'configured' : 'reset to env default'}`);
    }
    if (provider?.setCuratedModels) {
      provider.setCuratedModels(models);
      if (models !== undefined) {
        logger.info(
          `Applied model curation to ${record.providerId}: ${models.length} visible model(s)`
        );
      }
    }
    if (provider?.setCredentials && credentials) {
      if (isStartupSync && provider.logout && provider.getCredentials) {
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

    if (record.baseUrl) {
      config = { ...config, baseUrl: record.baseUrl };
    }

    const providerId = customProviderIdFor(config.id);

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

export async function syncAllProviders(
  listEnabled: () => ProviderRecord[],
  credentialManager: ProviderCredentialManager
): Promise<void> {
  initializeProviders();

  const records = listEnabled();
  for (const record of records) {
    try {
      const credentials = await credentialManager.getCredentials(record.providerId);
      await syncProviderToRegistry(record, credentials, true);
    } catch (err) {
      logger.warn(`Failed to sync provider ${record.providerId}:`, err);
    }
  }
}

export async function removeProviderFromRegistry(
  providerId: string,
  options: { preserveCredentials?: boolean } = {}
): Promise<void> {
  const registry = getProviderRegistry();
  const provider = registry.get(providerId);
  if (!provider) return;

  if (provider.logout && !options.preserveCredentials) {
    try {
      await provider.logout();
    } catch (err) {
      logger.warn(`Failed to log out provider ${providerId}:`, err);
    }
  }

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
