import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  CreateEvidenceRefParams,
  CreateEvolutionEpisodeParams,
  CreateEvolutionLessonParams,
  CreateEvolutionScopeParams,
  CreateMetricSnapshotParams,
  CreateTaskProposalParams,
  EvidenceKind,
  EvidenceRef,
  EvolutionEpisode,
  EvolutionEpisodeStatus,
  EvolutionLesson,
  EvolutionLessonStatus,
  EvolutionPolicy,
  EvolutionScope,
  EvolutionScopeKind,
  EvolutionScopeListParams,
  EvolutionListPagination,
  MetricDefinition,
  MetricSnapshot,
  MetricSnapshotValues,
  TaskProposal,
  TaskProposalStatus,
  UpdateEvolutionEpisodeParams,
  UpdateEvolutionLessonParams,
  UpdateEvolutionScopeParams,
  UpdateTaskProposalParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types.ts';

const MAX_LIST_LIMIT = 200;

export class EvolutionRepository {
  constructor(private db: BunDatabase) {}

  createScope(params: CreateEvolutionScopeParams): EvolutionScope {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO evolution_scopes (
					id, space_id, space_goal_id, kind, name, objective, parent_scope_id,
					metric_definitions_json, policy_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.spaceGoalId ?? null,
        params.kind,
        params.name,
        params.objective,
        params.parentScopeId ?? null,
        JSON.stringify(params.metricDefinitions ?? []),
        JSON.stringify(params.policy ?? {}),
        now,
        now
      );
    return this.getScope(id) as EvolutionScope;
  }

  getScope(id: string): EvolutionScope | null {
    const row = this.db.prepare(`SELECT * FROM evolution_scopes WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToScope(row) : null;
  }

  listScopes(params: EvolutionScopeListParams): EvolutionScope[] {
    const values: SQLiteValue[] = [params.spaceId];
    let where = `WHERE space_id = ?`;
    if (params.spaceGoalId !== undefined) {
      if (params.spaceGoalId === null) {
        where += ` AND space_goal_id IS NULL`;
      } else {
        where += ` AND space_goal_id = ?`;
        values.push(params.spaceGoalId);
      }
    }
    if (params.kind) {
      where += ` AND kind = ?`;
      values.push(params.kind);
    }
    const { sql, paginationValues } = appendLimitOffset({
      limit: params.limit,
      offset: params.offset,
    });
    const rows = this.db
      .prepare(`SELECT * FROM evolution_scopes ${where} ORDER BY updated_at DESC, id DESC${sql}`)
      .all(...values, ...paginationValues) as Record<string, unknown>[];
    return rows.map(rowToScope);
  }

  updateScope(id: string, params: UpdateEvolutionScopeParams): EvolutionScope | null {
    const sets: string[] = [];
    const values: SQLiteValue[] = [];
    const add = (column: string, value: SQLiteValue) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (params.spaceGoalId !== undefined) add('space_goal_id', params.spaceGoalId ?? null);
    if (params.kind !== undefined) add('kind', params.kind);
    if (params.name !== undefined) add('name', params.name);
    if (params.objective !== undefined) add('objective', params.objective);
    if (params.parentScopeId !== undefined) add('parent_scope_id', params.parentScopeId ?? null);
    if (params.metricDefinitions !== undefined) {
      add('metric_definitions_json', JSON.stringify(params.metricDefinitions));
    }
    if (params.policy !== undefined) add('policy_json', JSON.stringify(params.policy));
    if (sets.length === 0) return this.getScope(id);
    add('updated_at', Date.now());
    values.push(id);
    this.db.prepare(`UPDATE evolution_scopes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getScope(id);
  }

  createEvidence(params: CreateEvidenceRefParams): EvidenceRef {
    const id = generateUUID();
    const createdAt = params.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO evolution_evidence (
					id, scope_id, kind, summary, source_id, metadata_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.scopeId,
        params.kind,
        params.summary,
        params.sourceId ?? null,
        JSON.stringify(params.metadata ?? {}),
        createdAt
      );
    return this.getEvidence(id) as EvidenceRef;
  }

  getEvidence(id: string): EvidenceRef | null {
    const row = this.db.prepare(`SELECT * FROM evolution_evidence WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEvidence(row) : null;
  }

  updateEvidence(
    id: string,
    params: Pick<CreateEvidenceRefParams, 'summary' | 'metadata'>
  ): EvidenceRef {
    this.db
      .prepare(`UPDATE evolution_evidence SET summary = ?, metadata_json = ? WHERE id = ?`)
      .run(params.summary, JSON.stringify(params.metadata ?? {}), id);
    return this.getEvidence(id) as EvidenceRef;
  }

  listEvidence(scopeId: string, pagination?: EvolutionListPagination): EvidenceRef[] {
    const { sql, paginationValues } = appendLimitOffset(pagination);
    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_evidence WHERE scope_id = ? ORDER BY created_at DESC, id DESC${sql}`
      )
      .all(scopeId, ...paginationValues) as Record<string, unknown>[];
    return rows.map(rowToEvidence);
  }

  findLatestEvidenceBySource(scopeId: string, sourceId: string): EvidenceRef | null {
    const row = this.db
      .prepare(
        `SELECT * FROM evolution_evidence
				 WHERE scope_id = ? AND source_id = ?
				 ORDER BY created_at DESC, id DESC
				 LIMIT 1`
      )
      .get(scopeId, sourceId) as Record<string, unknown> | undefined;
    return row ? rowToEvidence(row) : null;
  }

  createEpisode(params: CreateEvolutionEpisodeParams): EvolutionEpisode {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO evolution_episodes (
					id, scope_id, status, rollup_applied_at, title, time_window_json, evidence_ids_json,
					outcome_summary, findings_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.scopeId,
        params.status ?? 'draft',
        null,
        params.title,
        jsonOrNull(params.timeWindow ?? null),
        JSON.stringify(params.evidenceIds ?? []),
        params.outcomeSummary ?? '',
        JSON.stringify(params.findings ?? []),
        now,
        now
      );
    return this.getEpisode(id) as EvolutionEpisode;
  }

  getEpisode(id: string): EvolutionEpisode | null {
    const row = this.db.prepare(`SELECT * FROM evolution_episodes WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEpisode(row) : null;
  }

  listEpisodes(scopeId: string, pagination?: EvolutionListPagination): EvolutionEpisode[] {
    const { sql, paginationValues } = appendLimitOffset(pagination);
    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_episodes WHERE scope_id = ? ORDER BY created_at DESC, id DESC${sql}`
      )
      .all(scopeId, ...paginationValues) as Record<string, unknown>[];
    return rows.map(rowToEpisode);
  }

  updateEpisode(id: string, params: UpdateEvolutionEpisodeParams): EvolutionEpisode | null {
    const sets: string[] = [];
    const values: SQLiteValue[] = [];
    const add = (column: string, value: SQLiteValue) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (params.status !== undefined) add('status', params.status);
    if (params.rollupAppliedAt !== undefined) add('rollup_applied_at', params.rollupAppliedAt);
    if (params.title !== undefined) add('title', params.title);
    if (params.timeWindow !== undefined) add('time_window_json', jsonOrNull(params.timeWindow));
    if (params.evidenceIds !== undefined)
      add('evidence_ids_json', JSON.stringify(params.evidenceIds));
    if (params.outcomeSummary !== undefined) add('outcome_summary', params.outcomeSummary);
    if (params.findings !== undefined) add('findings_json', JSON.stringify(params.findings));
    if (sets.length === 0) return this.getEpisode(id);
    add('updated_at', Date.now());
    values.push(id);
    this.db.prepare(`UPDATE evolution_episodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getEpisode(id);
  }

  createLesson(params: CreateEvolutionLessonParams): EvolutionLesson {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO evolution_lessons (
					id, scope_id, status, applies_to_json, rule, why,
					evidence_episode_ids_json, confidence, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.scopeId,
        params.status ?? 'candidate',
        JSON.stringify(params.appliesTo ?? []),
        params.rule,
        params.why,
        JSON.stringify(params.evidenceEpisodeIds ?? []),
        params.confidence ?? 0,
        now,
        now
      );
    return this.getLesson(id) as EvolutionLesson;
  }

  getLesson(id: string): EvolutionLesson | null {
    const row = this.db.prepare(`SELECT * FROM evolution_lessons WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToLesson(row) : null;
  }

  listLessons(
    scopeId: string,
    status?: EvolutionLessonStatus,
    pagination?: EvolutionListPagination
  ): EvolutionLesson[] {
    const values: SQLiteValue[] = [scopeId];
    let where = `WHERE scope_id = ?`;
    if (status) {
      where += ` AND status = ?`;
      values.push(status);
    }
    const { sql, paginationValues } = appendLimitOffset(pagination);
    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_lessons ${where} ORDER BY updated_at DESC, created_at DESC, id DESC${sql}`
      )
      .all(...values, ...paginationValues) as Record<string, unknown>[];
    return rows.map(rowToLesson);
  }

  updateLesson(id: string, params: UpdateEvolutionLessonParams): EvolutionLesson | null {
    const sets: string[] = [];
    const values: SQLiteValue[] = [];
    const add = (column: string, value: SQLiteValue) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (params.status !== undefined) add('status', params.status);
    if (params.appliesTo !== undefined) add('applies_to_json', JSON.stringify(params.appliesTo));
    if (params.rule !== undefined) add('rule', params.rule);
    if (params.why !== undefined) add('why', params.why);
    if (params.evidenceEpisodeIds !== undefined) {
      add('evidence_episode_ids_json', JSON.stringify(params.evidenceEpisodeIds));
    }
    if (params.confidence !== undefined) add('confidence', params.confidence);
    if (sets.length === 0) return this.getLesson(id);
    add('updated_at', Date.now());
    values.push(id);
    this.db.prepare(`UPDATE evolution_lessons SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getLesson(id);
  }

  createTaskProposal(params: CreateTaskProposalParams): TaskProposal {
    const id = generateUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO evolution_task_proposals (
					id, scope_id, title, description, reason, priority, status,
					evidence_episode_ids_json, created_task_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.scopeId,
        params.title,
        params.description,
        params.reason,
        params.priority ?? 'normal',
        params.status ?? 'proposed',
        JSON.stringify(params.evidenceEpisodeIds ?? []),
        params.createdTaskId ?? null,
        now,
        now
      );
    return this.getTaskProposal(id) as TaskProposal;
  }

  getTaskProposal(id: string): TaskProposal | null {
    const row = this.db.prepare(`SELECT * FROM evolution_task_proposals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTaskProposal(row) : null;
  }

  listTaskProposals(
    scopeId: string,
    status?: TaskProposalStatus,
    pagination?: EvolutionListPagination
  ): TaskProposal[] {
    const values: SQLiteValue[] = [scopeId];
    let where = `WHERE scope_id = ?`;
    if (status) {
      where += ` AND status = ?`;
      values.push(status);
    }
    const { sql, paginationValues } = appendLimitOffset(pagination);
    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_task_proposals ${where} ORDER BY updated_at DESC, id DESC${sql}`
      )
      .all(...values, ...paginationValues) as Record<string, unknown>[];
    return rows.map(rowToTaskProposal);
  }

  getTaskProposalByCreatedTaskId(taskId: string): TaskProposal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM evolution_task_proposals WHERE created_task_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTaskProposal(row) : null;
  }

  updateTaskProposal(id: string, params: UpdateTaskProposalParams): TaskProposal | null {
    return this.updateTaskProposalWhere(id, params);
  }

  updateTaskProposalIfStatus(
    id: string,
    statuses: TaskProposalStatus[],
    params: UpdateTaskProposalParams
  ): TaskProposal | null {
    if (statuses.length === 0) return null;
    return this.updateTaskProposalWhere(id, params, statuses);
  }

  private updateTaskProposalWhere(
    id: string,
    params: UpdateTaskProposalParams,
    statuses?: TaskProposalStatus[]
  ): TaskProposal | null {
    const sets: string[] = [];
    const values: SQLiteValue[] = [];
    const add = (column: string, value: SQLiteValue) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (params.title !== undefined) add('title', params.title);
    if (params.description !== undefined) add('description', params.description);
    if (params.reason !== undefined) add('reason', params.reason);
    if (params.priority !== undefined) add('priority', params.priority);
    if (params.status !== undefined) add('status', params.status);
    if (params.evidenceEpisodeIds !== undefined) {
      add('evidence_episode_ids_json', JSON.stringify(params.evidenceEpisodeIds));
    }
    if (params.createdTaskId !== undefined) add('created_task_id', params.createdTaskId ?? null);
    if (sets.length === 0) return this.getTaskProposal(id);
    add('updated_at', Date.now());
    let where = `id = ?`;
    values.push(id);
    if (statuses) {
      where += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
      values.push(...statuses);
    }
    const result = this.db
      .prepare(`UPDATE evolution_task_proposals SET ${sets.join(', ')} WHERE ${where}`)
      .run(...values);
    return result.changes > 0 ? this.getTaskProposal(id) : null;
  }

  createMetricSnapshot(params: CreateMetricSnapshotParams): MetricSnapshot {
    const id = generateUUID();
    const now = Date.now();
    const capturedAt = params.capturedAt ?? now;
    this.db
      .prepare(
        `INSERT INTO evolution_metric_snapshots (
					id, scope_id, captured_at, values_json, source, note, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.scopeId,
        capturedAt,
        JSON.stringify(params.values),
        params.source,
        params.note ?? null,
        now
      );
    return this.getMetricSnapshot(id) as MetricSnapshot;
  }

  getMetricSnapshot(id: string): MetricSnapshot | null {
    const row = this.db.prepare(`SELECT * FROM evolution_metric_snapshots WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToMetricSnapshot(row) : null;
  }

  listMetricSnapshots(scopeId: string, pagination?: EvolutionListPagination): MetricSnapshot[] {
    const { sql, paginationValues } = appendLimitOffset(pagination);
    const rows = this.db
      .prepare(
        `SELECT * FROM evolution_metric_snapshots WHERE scope_id = ? ORDER BY captured_at DESC, id DESC${sql}`
      )
      .all(scopeId, ...paginationValues) as Record<string, unknown>[];
    return rows.map(rowToMetricSnapshot);
  }
}

function rowToScope(row: Record<string, unknown>): EvolutionScope {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    spaceGoalId: (row.space_goal_id as string | null) ?? null,
    kind: row.kind as EvolutionScopeKind,
    name: row.name as string,
    objective: row.objective as string,
    parentScopeId: (row.parent_scope_id as string | null) ?? null,
    metricDefinitions: parseJson<MetricDefinition[]>(row.metric_definitions_json, []),
    policy: parseJson<EvolutionPolicy>(row.policy_json, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToEvidence(row: Record<string, unknown>): EvidenceRef {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    kind: row.kind as EvidenceKind,
    summary: row.summary as string,
    sourceId: (row.source_id as string | null) ?? null,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at as number,
  };
}

function rowToEpisode(row: Record<string, unknown>): EvolutionEpisode {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    status: row.status as EvolutionEpisodeStatus,
    rollupAppliedAt: (row.rollup_applied_at as number | null) ?? null,
    title: row.title as string,
    timeWindow: parseJson(row.time_window_json, null),
    evidenceIds: parseJson<string[]>(row.evidence_ids_json, []),
    outcomeSummary: (row.outcome_summary as string) ?? '',
    findings: parseJson(row.findings_json, []),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToLesson(row: Record<string, unknown>): EvolutionLesson {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    status: row.status as EvolutionLessonStatus,
    appliesTo: parseJson<string[]>(row.applies_to_json, []),
    rule: row.rule as string,
    why: row.why as string,
    evidenceEpisodeIds: parseJson<string[]>(row.evidence_episode_ids_json, []),
    confidence: (row.confidence as number | null) ?? 0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToTaskProposal(row: Record<string, unknown>): TaskProposal {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    title: row.title as string,
    description: row.description as string,
    reason: row.reason as string,
    priority: row.priority as TaskProposal['priority'],
    status: row.status as TaskProposalStatus,
    evidenceEpisodeIds: parseJson<string[]>(row.evidence_episode_ids_json, []),
    createdTaskId: (row.created_task_id as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToMetricSnapshot(row: Record<string, unknown>): MetricSnapshot {
  return {
    id: row.id as string,
    scopeId: row.scope_id as string,
    capturedAt: row.captured_at as number,
    values: parseJson<MetricSnapshotValues>(row.values_json, {}),
    source: row.source as string,
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function appendLimitOffset(pagination: EvolutionListPagination | undefined): {
  sql: string;
  paginationValues: SQLiteValue[];
} {
  if (!pagination) return { sql: '', paginationValues: [] };
  const rawLimit = pagination.limit;
  if (rawLimit === undefined || !Number.isFinite(rawLimit) || rawLimit <= 0) {
    return { sql: '', paginationValues: [] };
  }
  const limit = Math.min(MAX_LIST_LIMIT, Math.trunc(rawLimit));
  const rawOffset = pagination.offset;
  if (rawOffset !== undefined && Number.isFinite(rawOffset) && rawOffset > 0) {
    return { sql: ' LIMIT ? OFFSET ?', paginationValues: [limit, Math.trunc(rawOffset)] };
  }
  return { sql: ' LIMIT ?', paginationValues: [limit] };
}
