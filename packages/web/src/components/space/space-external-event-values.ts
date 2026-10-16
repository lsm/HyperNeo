import type { ExternalEventDeliveryStatus } from '../../lib/space-store.ts';
import type { ExtensionConfig } from './space-external-event-types.ts';

const WEBHOOK_PATH = '/webhook/github/space';

export const DELIVERY_STATUSES: Array<ExternalEventDeliveryStatus | ''> = [
  '',
  'pending',
  'delivered',
  'failed',
];

export function getWebhookUrl(): string {
  if (typeof window === 'undefined') return WEBHOOK_PATH;
  return new URL(WEBHOOK_PATH, window.location.origin).toString();
}

export function formatCapabilities(capabilities: ExtensionConfig['capabilities']): string[] {
  return [
    capabilities.webhooks !== false ? 'webhooks' : null,
    capabilities.polling ? 'polling' : null,
    capabilities.rpcConfig ? 'RPC config' : null,
  ].filter(Boolean) as string[];
}

export function formatTimestamp(value: number | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

export function formatJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
}

export function splitRepoInput(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//, '');
  const [owner, repo] = trimmed.split('/');
  if (!owner || !repo) return null;
  return { owner, repo: repo.replace(/\.git$/, '') };
}
