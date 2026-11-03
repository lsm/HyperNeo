import { createHash } from 'node:crypto';
import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';

type Peer = { id: string; name: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class Peers {
  constructor(private readonly db: Database) {}
  list() {
    return this.db.prepare('SELECT id,name FROM neo_peers ORDER BY name').all() as Peer[];
  }
  invite(id: string, name: string, code: string, expiresAt: number) {
    return this.db
      .prepare(`INSERT INTO neo_peers(id,name,invite_hash,expires_at) VALUES(?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET invite_hash=excluded.invite_hash,expires_at=excluded.expires_at
      RETURNING id`)
      .get(id, name, hash(code), expiresAt) as { id: string };
  }
  claim(code: string, credential: string) {
    const at = Date.now();
    return !!this.db
      .prepare(`UPDATE neo_peers SET credential_hash=?,invite_hash=NULL,expires_at=NULL
      WHERE invite_hash=? AND expires_at>? RETURNING id`)
      .get(hash(credential), hash(code), at);
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM neo_peers WHERE id=?').run(id);
  }
}
export const peerReads = defineRepositoryOp('neo.peer.read', 'read', Peers, ['list']);
export const peerWrites = defineRepositoryOp('neo.peer.write', 'write', Peers, [
  'invite',
  'claim',
  'remove',
]);
