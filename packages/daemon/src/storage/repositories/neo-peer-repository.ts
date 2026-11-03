import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';

export type NeoPeer = {
  id: string;
  name: string;
  address: string | null;
  credentialHash: string | null;
  inviteHash: string | null;
  expiresAt: number | null;
};
const columns = `id,name,address,credential_hash AS credentialHash,
  invite_hash AS inviteHash,expires_at AS expiresAt`;

class NeoPeers {
  constructor(private readonly db: Database) {}

  list(): NeoPeer[] {
    return this.db.prepare(`SELECT ${columns} FROM neo_peers ORDER BY name`).all() as NeoPeer[];
  }

  named(name: string): NeoPeer | null {
    return (
      (this.db.prepare(`SELECT ${columns} FROM neo_peers WHERE name=?`).get(name) as NeoPeer) ??
      null
    );
  }

  invitation(hash: string): NeoPeer | null {
    return (
      (this.db
        .prepare(`SELECT ${columns} FROM neo_peers WHERE invite_hash=?`)
        .get(hash) as NeoPeer) ?? null
    );
  }

  invite(id: string, name: string, hash: string, expiresAt: number): NeoPeer {
    return this.db
      .prepare(`INSERT INTO neo_peers(id,name,invite_hash,expires_at) VALUES(?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET invite_hash=excluded.invite_hash,expires_at=excluded.expires_at
      RETURNING ${columns}`)
      .get(id, name, hash, expiresAt) as NeoPeer;
  }

  claim(id: string, hash: string, at: number, credentialHash: string): boolean {
    return !!this.db
      .prepare(`UPDATE neo_peers SET credential_hash=?,invite_hash=NULL,expires_at=NULL
      WHERE id=? AND invite_hash=? AND expires_at>? RETURNING id`)
      .get(credentialHash, id, hash, at);
  }

  connect(id: string, name: string, address: string, existing: boolean): boolean {
    return existing
      ? !!this.db
          .prepare('UPDATE neo_peers SET address=? WHERE id=? AND name=? RETURNING id')
          .get(address, id, name)
      : !!this.db
          .prepare(`INSERT INTO neo_peers(id,name,address) VALUES(?,?,?)
          ON CONFLICT(name) DO NOTHING RETURNING id`)
          .get(id, name, address);
  }

  remove(id: string): boolean {
    return !!this.db.prepare('DELETE FROM neo_peers WHERE id=? RETURNING id').get(id);
  }
}

export const peerReads = defineRepositoryOp('neo.peer.read', 'read', NeoPeers, [
  'list',
  'named',
  'invitation',
]);
export const peerWrites = defineRepositoryOp('neo.peer.write', 'write', NeoPeers, [
  'invite',
  'claim',
  'connect',
  'remove',
]);
