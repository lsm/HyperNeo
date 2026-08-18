import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type { ProviderRecord, CreateProviderParams, UpdateProviderParams } from '@hyperneo/shared';
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

function rowToRecord(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    displayName: row.display_name,
    kind: row.kind as 'built_in' | 'custom_endpoint',
    authType: row.auth_type as 'api_key' | 'oauth' | 'none',
    isEnabled: row.is_enabled === 1,
    isDefault: row.is_default === 1,
    sortOrder: row.sort_order,
    baseUrl: row.base_url ?? undefined,
    configJson: row.config_json ?? undefined,
    customEndpointConfigJson: row.custom_endpoint_config_json ?? undefined,
    healthStatus: row.health_status as 'unknown' | 'healthy' | 'unhealthy',
    lastHealthCheckAt: row.last_health_check_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VALID_KINDS = new Set(['built_in', 'custom_endpoint']);
const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'none']);

function validateKind(kind: string): void {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid kind "${kind}". Must be one of: ${[...VALID_KINDS].join(', ')}`);
  }
}

function validateAuthType(authType: string): void {
  if (!VALID_AUTH_TYPES.has(authType)) {
    throw new Error(
      `Invalid authType "${authType}". Must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`
    );
  }
}

export class ProviderRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {}

  listProviders(): ProviderRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM providers ORDER BY sort_order ASC, created_at ASC`)
      .all() as ProviderRow[];
    return rows.map(rowToRecord);
  }

  listEnabledProviders(): ProviderRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM providers WHERE is_enabled = 1 ORDER BY sort_order ASC, created_at ASC`
      )
      .all() as ProviderRow[];
    return rows.map(rowToRecord);
  }

  getProvider(id: string): ProviderRecord | null {
    const row = this.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as
      | ProviderRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  getProviderByProviderId(providerId: string): ProviderRecord | null {
    const row = this.db.prepare(`SELECT * FROM providers WHERE provider_id = ?`).get(providerId) as
      | ProviderRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  isProviderIdTaken(providerId: string, excludeId?: string): boolean {
    if (excludeId) {
      const row = this.db
        .prepare(`SELECT 1 FROM providers WHERE provider_id = ? AND id != ?`)
        .get(providerId, excludeId);
      return row !== null;
    }
    const row = this.db.prepare(`SELECT 1 FROM providers WHERE provider_id = ?`).get(providerId);
    return row !== null;
  }

  createProvider(params: CreateProviderParams): ProviderRecord {
    validateKind(params.kind);
    validateAuthType(params.authType);

    if (this.isProviderIdTaken(params.providerId)) {
      throw new Error(`Provider "${params.providerId}" already exists`);
    }

    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO providers
          (id, provider_id, display_name, kind, auth_type, is_enabled, is_default, sort_order,
           base_url, config_json, custom_endpoint_config_json, health_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.providerId,
        params.displayName,
        params.kind,
        params.authType,
        (params.isEnabled ?? true) ? 1 : 0,
        (params.isDefault ?? false) ? 1 : 0,
        params.sortOrder ?? 0,
        params.baseUrl ?? null,
        params.configJson ?? null,
        params.customEndpointConfigJson ?? null,
        'unknown',
        now,
        now
      );

    this.reactiveDb.notifyChange('providers');
    const result = this.getProvider(id);
    if (!result) throw new Error(`Failed to read provider ${id} after write`);
    return result;
  }

  updateProvider(id: string, params: UpdateProviderParams): ProviderRecord | null {
    const existing = this.getProvider(id);
    if (!existing) return null;

    if (params.authType !== undefined) {
      validateAuthType(params.authType);
    }

    const now = Date.now();
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(params.displayName);
    }
    if (params.authType !== undefined) {
      fields.push('auth_type = ?');
      values.push(params.authType);
    }
    if (params.isEnabled !== undefined) {
      fields.push('is_enabled = ?');
      values.push(params.isEnabled ? 1 : 0);
    }
    if (params.isDefault !== undefined) {
      fields.push('is_default = ?');
      values.push(params.isDefault ? 1 : 0);
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
    if (params.lastHealthCheckAt !== undefined) {
      fields.push('last_health_check_at = ?');
      values.push(params.lastHealthCheckAt);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);
      this.db.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    this.reactiveDb.notifyChange('providers');
    const result = this.getProvider(id);
    if (!result) throw new Error(`Failed to read provider ${id} after write`);
    return result;
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
    const existing = this.getProvider(id);
    if (!existing) throw new Error(`Provider ${id} not found`);

    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE providers SET is_default = 0`).run();
      this.db.prepare(`UPDATE providers SET is_default = 1 WHERE id = ?`).run(id);
    });
    tx();

    this.reactiveDb.notifyChange('providers');
  }

  countProviders(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM providers`).get() as {
      count: number;
    };
    return row.count;
  }
}
