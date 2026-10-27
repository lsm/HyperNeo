import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';

class CodingConnectorIdentityCommands {
  constructor(private readonly db: Database) {}

  canonical(repo: string) {
    const alias = this.db
      .prepare('SELECT canonical FROM pack_coding_repo_aliases WHERE alias=?')
      .get(repo.toLowerCase()) as { canonical: string } | null;
    return alias?.canonical.toLowerCase() ?? repo.toLowerCase();
  }
}

export const codingConnectorIdentityReads = defineRepositoryOp(
  'coding.connector.identity',
  'read',
  CodingConnectorIdentityCommands,
  ['canonical']
);
