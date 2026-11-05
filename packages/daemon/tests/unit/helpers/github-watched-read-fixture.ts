import type { Database } from '../../../src/storage/sqlite-compat';

export const watchedColumns: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  space_id: 'TEXT',
  owner: 'TEXT',
  repo: 'TEXT',
  enabled: 'INTEGER',
  webhook_enabled: 'INTEGER',
  polling_enabled: 'INTEGER',
  webhook_secret: 'TEXT',
  webhook_remote_id: 'INTEGER',
  webhook_url: 'TEXT',
  webhook_auto_registered: 'INTEGER',
  webhook_active: 'INTEGER',
  webhook_last_checked_at: 'INTEGER',
  webhook_last_error: 'TEXT',
  webhook_configured_at: 'INTEGER',
  last_webhook_at: 'INTEGER',
  last_poll_at: 'INTEGER',
  poll_cursor: 'TEXT',
  created_at: 'INTEGER',
  updated_at: 'INTEGER',
};
export const watchedRow: Record<string, string | number | null> = {
  id: 'synthetic-one',
  space_id: 'synthetic-space',
  owner: 'OwnerZ',
  repo: 'repo-z',
  enabled: 1,
  webhook_enabled: 1,
  polling_enabled: 1,
  webhook_secret: 'synthetic-webhook-only',
  webhook_remote_id: 7,
  webhook_url: 'https://example.invalid/hook',
  webhook_auto_registered: 1,
  webhook_active: 0,
  webhook_last_checked_at: 11,
  webhook_last_error: 'synthetic diagnostic',
  webhook_configured_at: 12,
  last_webhook_at: 13,
  last_poll_at: 14,
  poll_cursor: '{"lastSeenAt":15,"etags":{"issues":"synthetic-etag"}}',
  created_at: 17,
  updated_at: 18,
};
export const mappedWatchedRow = {
  id: 'synthetic-one',
  spaceId: 'synthetic-space',
  owner: 'OwnerZ',
  repo: 'repo-z',
  enabled: true,
  webhookEnabled: true,
  pollingEnabled: true,
  webhookSecret: 'synthetic-webhook-only',
  webhookRemoteId: 7,
  webhookUrl: 'https://example.invalid/hook',
  webhookAutoRegistered: true,
  webhookActive: false,
  webhookLastCheckedAt: 11,
  webhookLastError: 'synthetic diagnostic',
  webhookConfiguredAt: 12,
  lastWebhookAt: 13,
  lastPollAt: 14,
  pollCursor: { lastSeenAt: 15, etags: { issues: 'synthetic-etag' } },
  createdAt: 17,
  updatedAt: 18,
};
export function createWatchedTable(db: Database): void {
  db.exec(
    'CREATE TABLE space_github_watched_repos(' +
      Object.entries(watchedColumns)
        .map(([name, type]) => name + ' ' + type)
        .join(',') +
      ')'
  );
}
export function insertWatchedRow(
  db: Database,
  overrides: Record<string, string | number | null> = {}
): void {
  const row = { ...watchedRow, ...overrides },
    keys = Object.keys(row);
  db.prepare(
    'INSERT INTO space_github_watched_repos(' +
      keys.join(',') +
      ') VALUES(' +
      keys.map(() => '?').join(',') +
      ')'
  ).run(...keys.map((key) => row[key]));
}
