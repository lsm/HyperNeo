import { describe, expect, it } from 'bun:test';
import {
  PROVIDER_ENV_OWNER_ROLES,
  PROVIDER_ENV_READER_ROLES,
  providerEnvCoordinator,
} from '../../../../src/lib/providers/provider-env-enrollment';

describe('provider env enrollment', () => {
  it('enrolls the ambient credential readers as readers', () => {
    expect(PROVIDER_ENV_READER_ROLES).toEqual([
      'anthropic.isAvailable',
      'auth-manager',
      'provider-credential-manager.hasEnvironmentCredentials',
      'anthropic-copilot.credentials',
    ]);
    for (const role of PROVIDER_ENV_READER_ROLES) {
      expect(providerEnvCoordinator.roleOf(role)).toBe('reader');
    }
  });

  it('enrolls the Anthropic model loader, ACP query, and the QueryRunner window as owning paths', () => {
    expect(PROVIDER_ENV_OWNER_ROLES).toEqual([
      'anthropic.loadModelsFromSdk',
      'acp.query',
      'query-runner',
    ]);
    expect(providerEnvCoordinator.roleOf('anthropic.loadModelsFromSdk')).toBe('owner');
    expect(providerEnvCoordinator.roleOf('acp.query')).toBe('owner');
    expect(providerEnvCoordinator.roleOf('query-runner')).toBe('owner');
  });

  it('admits enrolled readers through the shared coordinator and leaves it free', async () => {
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
    const result = await providerEnvCoordinator.runWithLease('auth-manager', () => 'read');
    expect(result).toBe('read');
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
  });
});
