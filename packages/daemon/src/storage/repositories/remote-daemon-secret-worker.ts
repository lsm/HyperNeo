import type { DaemonAttachment } from '../../lib/remote-daemons/registry.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { SettingsRepository } from './settings-repository.ts';

export const saveRemoteDaemonSecret = defineDbOp({
  name: 'remoteDaemon.secret.save',
  mode: 'write',
  run: (
    db: Database,
    secret: {
      daemonId: string;
      url: string;
      credential: string;
      now: number;
      peerDaemonId?: string;
    }
  ): void => {
    db.prepare(
      `INSERT INTO remote_daemon_secrets (daemon_id, url, credential, created_at, peer_daemon_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (daemon_id) DO UPDATE SET url = excluded.url, credential = excluded.credential,
         created_at = excluded.created_at, peer_daemon_id = excluded.peer_daemon_id`
    ).run(secret.daemonId, secret.url, secret.credential, secret.now, secret.peerDaemonId ?? null);
  },
});

export const removeRemoteDaemonSecret = defineDbOp({
  name: 'remoteDaemon.secret.remove',
  mode: 'write',
  run: (db: Database, daemonId: string): void => {
    db.prepare('DELETE FROM remote_daemon_secrets WHERE daemon_id = ?').run(daemonId);
  },
});

export const editRemoteDaemonEndpoint = defineDbOp({
  name: 'remoteDaemon.endpoint.edit',
  mode: 'write',
  run: (
    db: Database,
    input: { edited: DaemonAttachment; previousUrl: string; attachments: DaemonAttachment[] },
    changes
  ): boolean => {
    const { edited, previousUrl, attachments } = input;
    const result = db
      .prepare('UPDATE remote_daemon_secrets SET url = ? WHERE daemon_id = ? AND url = ?')
      .run(edited.url, edited.daemonId, previousUrl);
    if (result.changes === 0) return false;
    new SettingsRepository(db).updateGlobalSettings({ attachedDaemons: attachments });
    changes.notifyChange('global_settings');
    return true;
  },
});
