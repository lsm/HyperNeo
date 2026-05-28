import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { CreateProviderParams, ProviderRecord, UpdateProviderParams } from '@neokai/shared';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

interface ProviderRow {
  id: string;
  provider_id: string;
  display_name: string;
  kind: string;
  auth_type: string;
  is_enabled: number;
  is_default: number;
  sort_order: number;
  base_url: string | null;
  config_json: string | null;
  custom_endpoint_config_json: string | null;
  health_status: string;
  last_health_check_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    displayName: row.display_name,
    kind: row.kind as ProviderRecord['kind'],
    authType: row.auth_type as ProviderRecord['authType'],
    isEnabled: row.is_enabled === 1,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
    ...(row.base_url !== null ? { baseUrl: row.base_url } : {}),
    ...(row.config_json !== null ? { configJson: row.config_json } : {}),
    ...(row.custom_endpoint_config_json !== null
      ? { customEndpointConfigJson: row.custom_endpoint_config_json }
      : {}),
    healthStatus: row.health_status as ProviderRecord['healthStatus'],
    ...(row.last_health_check_at !== null ? { lastHealthCheckAt: row.last_health_check_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProviderRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {}

  listProviders(): ProviderRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM providers ORDER BY sort_order ASC`)
      .all() as ProviderRow[];
    return rows.map(rowToProvider);
  }

  getProvider(id: string): ProviderRecord | null {
    const row = this.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as
      | ProviderRow
      | undefined;
    return row ? rowToProvider(row) : null;
  }

  getProviderByProviderId(providerId: string): ProviderRecord | null {
    const row = this.db.prepare(`SELECT * FROM providers WHERE provider_id = ?`).get(providerId) as
      | ProviderRow
      | undefined;
    return row ? rowToProvider(row) : null;
  }

  createProvider(params: CreateProviderParams): ProviderRecord {
    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO providers (
          id, provider_id, display_name, kind, auth_type, is_enabled, is_default,
          sort_order, base_url, config_json, custom_endpoint_config_json,
          health_status, last_health_check_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.providerId,
        params.displayName,
        params.kind,
        params.authType,
        (params.isEnabled ?? true) ? 1 : 0,
        (params.isDefault ?? false) ? 1 : 0,
        params.sortOrder,
        params.baseUrl ?? null,
        params.configJson ?? null,
        params.customEndpointConfigJson ?? null,
        params.healthStatus ?? 'unknown',
        params.lastHealthCheckAt ?? null,
        now,
        now
      );

    this.reactiveDb.notifyChange('providers');
    return this.getProvider(id)!;
  }

  updateProvider(id: string, params: UpdateProviderParams): ProviderRecord | null {
    const existing = this.getProvider(id);
    if (!existing) return null;

    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.providerId !== undefined) {
      fields.push('provider_id = ?');
      values.push(params.providerId);
    }
    if (params.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(params.displayName);
    }
    if (params.kind !== undefined) {
      fields.push('kind = ?');
      values.push(params.kind);
    }
    if (params.authType !== undefined) {
      fields.push('auth_type = ?');
      values.push(params.authType);
    }
    if (params.isEnabled !== undefined) {
      fields.push('is_enabled = ?');
      values.push(params.isEnabled ? 1 : 0);
    }
    if (params.isDefault === false) {
      fields.push('is_default = ?');
      values.push(0);
    }
    if (params.sortOrder !== undefined) {
      fields.push('sort_order = ?');
      values.push(params.sortOrder);
    }
    if ('baseUrl' in params) {
      fields.push('base_url = ?');
      values.push(params.baseUrl ?? null);
    }
    if ('configJson' in params) {
      fields.push('config_json = ?');
      values.push(params.configJson ?? null);
    }
    if ('customEndpointConfigJson' in params) {
      fields.push('custom_endpoint_config_json = ?');
      values.push(params.customEndpointConfigJson ?? null);
    }
    if (params.healthStatus !== undefined) {
      fields.push('health_status = ?');
      values.push(params.healthStatus);
    }
    if ('lastHealthCheckAt' in params) {
      fields.push('last_health_check_at = ?');
      values.push(params.lastHealthCheckAt ?? null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      this.db.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      if (params.isDefault === true) {
        this.setDefaultProvider(id);
      } else {
        this.reactiveDb.notifyChange('providers');
      }
    } else if (params.isDefault === true) {
      this.setDefaultProvider(id);
    }

    return this.getProvider(id);
  }

  deleteProvider(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
    const deleted = result.changes > 0;
    if (deleted) {
      this.reactiveDb.notifyChange('providers');
    }
    return deleted;
  }

  setDefaultProvider(id: string): void {
    const didUpdate = this.db.transaction(() => {
      const now = Date.now();
      const result = this.db
        .prepare(`UPDATE providers SET is_default = 1, updated_at = ? WHERE id = ?`)
        .run(now, id);
      if (result.changes === 0) return false;

      this.db
        .prepare(`UPDATE providers SET is_default = 0, updated_at = ? WHERE id != ?`)
        .run(now, id);
      return true;
    })();

    if (didUpdate) {
      this.reactiveDb.notifyChange('providers');
    }
  }
}
