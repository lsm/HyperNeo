import { ProviderEnvCoordinator } from './provider-env-coordinator.ts';

export const PROVIDER_ENV_READER_ROLES = [
  'anthropic.isAvailable',
  'auth-manager',
  'provider-credential-manager.hasEnvironmentCredentials',
  'anthropic-copilot.credentials',
] as const;

export const PROVIDER_ENV_OWNER_ROLES = ['anthropic.loadModelsFromSdk'] as const;

export const providerEnvCoordinator = new ProviderEnvCoordinator();

for (const role of PROVIDER_ENV_READER_ROLES) {
  providerEnvCoordinator.registerReader(role);
}

for (const role of PROVIDER_ENV_OWNER_ROLES) {
  providerEnvCoordinator.registerOwner(role);
}
