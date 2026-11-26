import type { DaemonAttachment } from '../../lib/remote-daemons/registry.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import type { Database } from '../sqlite-compat.ts';
import {
  editRemoteDaemonEndpoint,
  removeRemoteDaemonSecret,
  saveRemoteDaemonSecret,
} from './remote-daemon-secret-worker.ts';
import { invalidateGlobalSettings } from './settings-repository.ts';

export class RemoteDaemonSecretRepository {
  constructor(private readonly db: Database) {}

  save(
    daemonId: string,
    url: string,
    credential: string,
    now: number,
    peerDaemonId?: string
  ): Promise<void> {
    return gatewayFor(this.db).run(saveRemoteDaemonSecret, {
      daemonId,
      url,
      credential,
      now,
      peerDaemonId,
    });
  }

  credentialFor(daemonId: string, url: string): string | null {
    const row = this.db
      .prepare('SELECT credential FROM remote_daemon_secrets WHERE daemon_id = ? AND url = ?')
      .get(daemonId, url) as { credential: string } | undefined;
    return row?.credential ?? null;
  }

  async updateEndpoint(
    edited: DaemonAttachment,
    previousUrl: string,
    attachments: DaemonAttachment[]
  ): Promise<boolean> {
    const updated = await gatewayFor(this.db).run(editRemoteDaemonEndpoint, {
      edited,
      previousUrl,
      attachments,
    });
    if (updated) invalidateGlobalSettings(this.db);
    return updated;
  }

  routesForPeer(peerDaemonId: string): { daemonId: string; url: string }[] {
    return this.db
      .query<{ daemonId: string; url: string }, [string]>(
        'SELECT daemon_id AS daemonId, url FROM remote_daemon_secrets WHERE peer_daemon_id = ?'
      )
      .all(peerDaemonId);
  }

  remove(daemonId: string): Promise<void> {
    return gatewayFor(this.db).run(removeRemoteDaemonSecret, daemonId);
  }
}
