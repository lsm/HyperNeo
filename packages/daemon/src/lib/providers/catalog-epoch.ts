let providerCatalogEpoch = 0;

const providerCatalogRevisions = new Map<string, number>();

export function bumpProviderCatalogEpoch(providerId?: string): void {
  providerCatalogEpoch += 1;
  if (providerId) {
    providerCatalogRevisions.set(providerId, (providerCatalogRevisions.get(providerId) ?? 0) + 1);
  }
}

export function getProviderCatalogEpoch(providerId?: string): number {
  if (providerId) {
    return providerCatalogRevisions.get(providerId) ?? 0;
  }
  return providerCatalogEpoch;
}
