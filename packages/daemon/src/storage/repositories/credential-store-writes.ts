import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

interface EncryptedCredential {
  providerId: string;
  encrypted: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

class CredentialStoreRepository {
  constructor(private readonly db: Database) {}

  set(record: EncryptedCredential): void {
    this.db
      .prepare(
        `INSERT INTO provider_credentials (provider_id, encrypted_data, iv, tag, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           encrypted_data = excluded.encrypted_data,
           iv = excluded.iv,
           tag = excluded.tag,
           updated_at = excluded.updated_at`
      )
      .run(record.providerId, record.encrypted, record.iv, record.tag, Date.now());
  }

  delete(providerId: string): void {
    this.db.prepare('DELETE FROM provider_credentials WHERE provider_id = ?').run(providerId);
  }
}

export const credentialStoreWrites = defineRepositoryOp(
  'credentials.write',
  'write',
  CredentialStoreRepository,
  ['set', 'delete']
);
