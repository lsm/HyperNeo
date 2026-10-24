import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

export interface ClientRegistration {
  clientId: string;
  kind: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

type Row = Omit<ClientRegistration, 'data'> & { dataJson: string };

export const registerClient = defineDbOp({
  name: 'client.registration.register',
  mode: 'write',
  run: (db: Database, registration: ClientRegistration): void => {
    db.prepare(
      `INSERT INTO client_registrations(client_id, kind, data_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id, kind) DO UPDATE SET
         data_json = excluded.data_json, updated_at = excluded.updated_at`
    ).run(
      registration.clientId,
      registration.kind,
      JSON.stringify(registration.data),
      registration.updatedAt
    );
  },
});

export const unregisterClient = defineDbOp({
  name: 'client.registration.unregister',
  mode: 'write',
  run: (db: Database, { clientId, kind }: { clientId: string; kind: string | null }): number =>
    db
      .prepare('DELETE FROM client_registrations WHERE client_id = ? AND (? IS NULL OR kind = ?)')
      .run(clientId, kind, kind).changes,
});

export class ClientRegistrationRepository {
  constructor(private readonly db: Database) {}

  register(registration: ClientRegistration): Promise<void> {
    return gatewayFor(this.db).run(registerClient, registration);
  }

  unregister(clientId: string, kind?: string): Promise<number> {
    return gatewayFor(this.db).run(unregisterClient, { clientId, kind: kind ?? null });
  }

  list(kind?: string): ClientRegistration[] {
    return (
      this.db
        .prepare(
          `SELECT client_id AS clientId, kind, data_json AS dataJson, updated_at AS updatedAt
           FROM client_registrations WHERE ? IS NULL OR kind = ? ORDER BY updated_at DESC, client_id, kind`
        )
        .all(kind ?? null, kind ?? null) as Row[]
    ).map(({ dataJson, ...rest }) => ({
      ...rest,
      data: JSON.parse(dataJson) as Record<string, unknown>,
    }));
  }
}
