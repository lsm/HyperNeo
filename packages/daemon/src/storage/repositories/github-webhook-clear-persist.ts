import type { Database } from '../sqlite-compat.ts';

export function clearGitHubWebhookRegistration(
  db: Database,
  id: string,
  clearSecret = false
): void {
  db.prepare(
    `UPDATE space_github_watched_repos
         SET webhook_secret = CASE WHEN ? THEN NULL ELSE webhook_secret END,
             webhook_remote_id = NULL, webhook_url = NULL, webhook_auto_registered = 0, webhook_active = NULL,
             webhook_last_checked_at = NULL, webhook_last_error = NULL, webhook_configured_at = NULL,
             last_webhook_at = NULL, updated_at = ?
         WHERE id = ?`
  ).run(clearSecret ? 1 : 0, Date.now(), id);
}

export function clearGitHubWebhookDeliveryHistory(db: Database, id: string): void {
  db.prepare(
    `UPDATE space_github_watched_repos SET last_webhook_at = NULL, updated_at = ? WHERE id = ?`
  ).run(Date.now(), id);
}
