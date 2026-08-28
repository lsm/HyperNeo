import type { ProviderCredentials } from '@hyperneo/shared/provider';

export function sameCredentialIdentity(
  existing: ProviderCredentials | null,
  incoming: ProviderCredentials
): boolean {
  if (!existing || existing.type !== incoming.type) return false;
  if (incoming.type === 'api_key' && existing.type === 'api_key') {
    return existing.apiKey === incoming.apiKey;
  }
  if (incoming.type === 'oauth' && existing.type === 'oauth') {
    return (
      existing.accessToken === incoming.accessToken &&
      existing.refreshToken === incoming.refreshToken
    );
  }
  return false;
}
