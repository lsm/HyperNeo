import type { Database as BunDatabase } from 'bun:sqlite';
import type { ReactiveDatabase } from '../reactive-database';

/**
 * The owner/scope of a memory row.
 *
 * - `space` — shared across the whole Space (the legacy single-pool behavior).
 *   `ownerAgentId` is null.
 * - `agent` — private to one long-horizon agent. `ownerAgentId` is the agent id
 *   resolved from the writing session's `promptProvenance.agentId`.
 */
export type AgentMemoryScope = 'agent' | 'space';

/**
 * Read-side scope filter for search/list/read/delete.
 *
 * - `mine` — only rows owned by the caller's agent (no shared rows).
 * - `space` — only shared (space-scoped) rows.
 * - `all` — every row in the Space regardless of owner.
 *
 * When omitted (and `ownerAgentId` is set) the default is "mine + space": the
 * caller's private rows plus all shared rows — the natural view for an agent
 * that wants its own memory and the common knowledge.
 */
export type AgentMemoryScopeFilter = 'mine' | 'space' | 'all';

export interface AgentMemoryEntry {
  key: string;
  spaceId: string;
  /** Agent id that owns this row, or null when space-scoped (shared). */
  ownerAgentId: string | null;
  scope: AgentMemoryScope;
  content: string;
  tags: string[];
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number | null;
}

export interface AgentMemorySearchResult {
  memory: AgentMemoryEntry;
  rank: number;
}

export interface AgentMemoryCoreEntry extends AgentMemoryEntry {
  score: number;
}

export interface AgentMemoryConsolidationOptions {
  spaceId?: string;
  staleTtlMs?: number;
  duplicateJaccardThreshold?: number;
  coreLimit?: number;
}

export interface AgentMemoryConsolidationResult {
  spacesProcessed: number;
  duplicatesMerged: number;
  memoriesPruned: number;
  coreMemoriesWritten: number;
}

export interface AgentMemoryEmbedder {
  model: string;
  dimensions: number;
  embedQuery(text: string): Float32Array | number[] | Promise<Float32Array | number[]>;
  embedPassage(text: string): Float32Array | number[] | Promise<Float32Array | number[]>;
}

interface AgentMemoryRow {
  id: number;
  key: string;
  space_id: string;
  owner_agent_id: string;
  scope: AgentMemoryScope;
  content: string;
  tags: string;
  created_by_session: string | null;
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed_at: number | null;
  embedding_status: 'pending' | 'ready' | 'failed';
  embedding_model: string | null;
  embedding_updated_at: number | null;
  embedding_error: string | null;
  embedding_revision: number;
  embedding_token: string;
}

interface AgentMemorySearchRow extends AgentMemoryRow {
  rank: number;
}

interface AgentMemoryVectorRow extends AgentMemoryRow {
  embedding: Buffer;
  dimensions: number;
  model: string;
}

interface RankedRow {
  row: AgentMemorySearchRow;
  rank: number;
}

const MEMORY_CONTENT_MAX_LENGTH = 10_000;
const MEMORY_TAG_MAX_LENGTH = 50;
const MEMORY_TAG_MAX_COUNT = 50;
const RRF_K = 60;
const VECTOR_CANDIDATE_LIMIT = 100;
const EMBEDDING_ERROR_MAX_LENGTH = 500;
const EMBEDDING_BACKFILL_BATCH_SIZE = 25;
const DEFAULT_STALE_MEMORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_DUPLICATE_JACCARD_THRESHOLD = 0.82;
const DEFAULT_CORE_MEMORY_LIMIT = 10;
const DUPLICATE_COMPARISON_LIMIT = 1_000;
const STALE_DELETE_BATCH_SIZE = 500;

export class AgentMemoryRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase,
    private embedder?: AgentMemoryEmbedder
  ) {}

  write(params: {
    spaceId: string;
    key: string;
    content: string;
    tags?: string[];
    createdBySession?: string | null;
    /** Agent id that owns this row. Omit/null for a shared (space-scoped) row. */
    ownerAgentId?: string | null;
    /** Force the write target. Defaults to 'agent' when an owner is given. */
    scope?: AgentMemoryScope;
  }): AgentMemoryEntry {
    const key = normalizeKey(params.key);
    const content = normalizeContent(params.content);
    const tagsProvided = params.tags !== undefined;
    const tags = normalizeTags(params.tags ?? []);
    const now = Date.now();
    const embeddingToken = crypto.randomUUID();

    // Resolve the namespace. An explicit scope='space' writes to the shared pool
    // even when an owner id is supplied (an agent contributing common knowledge).
    // Otherwise an owner id makes the row agent-scoped (private).
    const ownerInput = (params.ownerAgentId ?? '').trim();
    const ownerAgentId = params.scope === 'space' ? '' : ownerInput;
    const scope: AgentMemoryScope = ownerAgentId ? 'agent' : 'space';

    // On conflict (same space + owner + key): preserve `tags` when caller did
    // not supply them and never overwrite `created_by_session` or the owner/scope
    // so provenance and namespace stay with the original author.
    const row = this.db
      .prepare(
        `INSERT INTO space_agent_memory
					(key, space_id, owner_agent_id, scope, content, tags, created_by_session, created_at, updated_at, access_count, last_accessed_at, embedding_status, embedding_model, embedding_updated_at, embedding_error, embedding_revision, embedding_token)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'pending', NULL, NULL, NULL, 1, ?)
				 ON CONFLICT(space_id, owner_agent_id, key) DO UPDATE SET
					content = excluded.content,
					tags = CASE WHEN ? = 1 THEN excluded.tags ELSE space_agent_memory.tags END,
					updated_at = excluded.updated_at,
					embedding_status = 'pending',
					embedding_model = NULL,
					embedding_updated_at = NULL,
					embedding_error = NULL,
					embedding_revision = space_agent_memory.embedding_revision + 1,
						embedding_token = excluded.embedding_token
				 RETURNING *`
      )
      .get(
        key,
        params.spaceId,
        ownerAgentId,
        scope,
        content,
        serializeTags(tags),
        params.createdBySession ?? null,
        now,
        now,
        embeddingToken,
        tagsProvided ? 1 : 0
      ) as AgentMemoryRow;

    this.updateEmbedding(row);
    this.reactiveDb?.notifyChange('space_agent_memory');
    return rowToEntry(row);
  }

  read(
    spaceId: string,
    key: string,
    options?: {
      ownerAgentId?: string | null;
      scope?: AgentMemoryScopeFilter;
      recordAccess?: boolean;
    }
  ): AgentMemoryEntry | null {
    const normalizedKey = normalizeKey(key);
    const owner = (options?.ownerAgentId ?? '').trim();
    const scope = options?.scope;

    let row: AgentMemoryRow | undefined;
    if (scope === 'mine') {
      // Only the caller's own row; never falls back to shared.
      row = owner ? this.readRow(spaceId, normalizedKey, owner) : undefined;
    } else if (scope === 'space' || (!scope && !owner)) {
      // Shared pool only (also the default when there is no owner context —
      // e.g. RPC/UI callers that have no agent attribution).
      row = this.readRow(spaceId, normalizedKey, '');
    } else {
      // Default (mine + space) or explicit 'all': prefer the caller's own row,
      // then fall back to the shared row.
      row = (owner && this.readRow(spaceId, normalizedKey, owner)) || undefined;
      row = row ?? this.readRow(spaceId, normalizedKey, '');
    }

    if (!row) return null;
    if (options?.recordAccess !== false) this.recordAccessById(row.id);
    return rowToEntry(row);
  }

  private readRow(
    spaceId: string,
    normalizedKey: string,
    ownerAgentId: string
  ): AgentMemoryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM space_agent_memory WHERE space_id = ? AND key = ? AND owner_agent_id = ?`
      )
      .get(spaceId, normalizedKey, ownerAgentId) as AgentMemoryRow | undefined;
  }

  delete(
    spaceId: string,
    key: string,
    options?: { ownerAgentId?: string | null; scope?: AgentMemoryScopeFilter }
  ): boolean {
    const normalizedKey = normalizeKey(key);
    const owner = (options?.ownerAgentId ?? '').trim();
    const scope = options?.scope;

    // Resolve which owner namespace(s) a delete may touch. A caller never
    // deletes another agent's private row: 'mine' targets only the caller's row,
    // the default (mine + space) targets the caller's row and the shared row,
    // and 'space'/no-owner targets only the shared row.
    const owners: string[] = [];
    if (scope === 'all') {
      // Administrators only — wipe every row under this key across owners.
      const all = this.db
        .prepare(
          `SELECT DISTINCT owner_agent_id AS o FROM space_agent_memory WHERE space_id = ? AND key = ?`
        )
        .all(spaceId, normalizedKey) as Array<{ o: string }>;
      owners.push(...all.map((row) => row.o));
    } else if (scope === 'mine') {
      if (owner) owners.push(owner);
    } else if (scope === 'space' || !owner) {
      owners.push('');
    } else {
      // default: mine + space
      owners.push(owner, '');
    }

    if (owners.length === 0) return false;
    const placeholders = owners.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `DELETE FROM space_agent_memory WHERE space_id = ? AND key = ? AND owner_agent_id IN (${placeholders})`
      )
      .run(spaceId, normalizedKey, ...owners);
    if (result.changes > 0) this.reactiveDb?.notifyChange('space_agent_memory');
    return result.changes > 0;
  }

  async search(
    spaceId: string,
    query: string,
    limit = 10,
    options?: { ownerAgentId?: string | null; scope?: AgentMemoryScopeFilter }
  ): Promise<AgentMemorySearchResult[]> {
    return (await this.searchWithOptions(spaceId, query, { limit, ...options })).map((row) => ({
      memory: rowToEntry(row),
      rank: row.rank,
    }));
  }

  async list(
    spaceId: string,
    options?: {
      query?: string;
      limit?: number;
      offset?: number;
      ownerAgentId?: string | null;
      scope?: AgentMemoryScopeFilter;
    }
  ): Promise<AgentMemoryEntry[]> {
    const limit = normalizeLimit(options?.limit ?? 50, 100);
    const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
    const query = options?.query?.trim();

    if (query) {
      return (
        await this.searchWithOptions(spaceId, query, {
          limit,
          offset,
          maxLimit: 100,
          ownerAgentId: options?.ownerAgentId,
          scope: options?.scope,
        })
      ).map(rowToEntry);
    }

    const ownerFilter = buildOwnerFilter(options?.ownerAgentId, options?.scope, 'm');
    const rows = this.db
      .prepare(
        `SELECT m.* FROM space_agent_memory m
				 WHERE m.space_id = ?
				 ${ownerFilter.clause ? `AND ${ownerFilter.clause}` : ''}
				 ORDER BY m.updated_at DESC, m.key ASC
				 LIMIT ? OFFSET ?`
      )
      .all(spaceId, ...ownerFilter.params, limit, offset) as AgentMemoryRow[];
    return rows.map(rowToEntry);
  }

  recordAccess(spaceId: string, key: string, ownerAgentId?: string | null): void {
    const owner = (ownerAgentId ?? '').trim();
    this.db
      .prepare(
        `UPDATE space_agent_memory
				 SET access_count = access_count + 1, last_accessed_at = ?
				 WHERE space_id = ? AND key = ? AND owner_agent_id = ?`
      )
      .run(Date.now(), spaceId, normalizeKey(key), owner);
    this.reactiveDb?.notifyChange('space_agent_memory');
  }

  private recordAccessById(id: number): void {
    this.db
      .prepare(
        `UPDATE space_agent_memory
				 SET access_count = access_count + 1, last_accessed_at = ?
				 WHERE id = ?`
      )
      .run(Date.now(), id);
    this.reactiveDb?.notifyChange('space_agent_memory');
  }

  consolidate(options?: AgentMemoryConsolidationOptions): AgentMemoryConsolidationResult {
    const staleTtlMs =
      options?.staleTtlMs !== undefined
        ? Math.max(0, options.staleTtlMs)
        : DEFAULT_STALE_MEMORY_TTL_MS;
    const duplicateJaccardThreshold = Math.min(
      1,
      Math.max(0, options?.duplicateJaccardThreshold ?? DEFAULT_DUPLICATE_JACCARD_THRESHOLD)
    );
    const coreLimit = normalizeLimit(options?.coreLimit ?? DEFAULT_CORE_MEMORY_LIMIT, 50);
    const spaceIds = options?.spaceId ? [options.spaceId] : this.listSpaceIdsWithMemories();
    const result: AgentMemoryConsolidationResult = {
      spacesProcessed: 0,
      duplicatesMerged: 0,
      memoriesPruned: 0,
      coreMemoriesWritten: 0,
    };

    const run = this.db.transaction(() => {
      for (const spaceId of spaceIds) {
        result.spacesProcessed++;
        result.memoriesPruned += this.pruneStaleMemories(spaceId, staleTtlMs);
        result.duplicatesMerged += this.mergeDuplicateMemories(spaceId, duplicateJaccardThreshold);
        result.coreMemoriesWritten += this.refreshCoreMemories(spaceId, coreLimit);
      }
    });
    run();
    if (
      result.duplicatesMerged > 0 ||
      result.memoriesPruned > 0 ||
      result.coreMemoriesWritten > 0
    ) {
      this.reactiveDb?.notifyChange('space_agent_memory');
      this.reactiveDb?.notifyChange('space_agent_core_memory');
    }
    return result;
  }

  listCoreMemories(spaceId: string, limit = DEFAULT_CORE_MEMORY_LIMIT): AgentMemoryCoreEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, c.score
				 FROM space_agent_core_memory c
				 JOIN space_agent_memory m ON m.id = c.memory_id
				 WHERE c.space_id = ?
				 ORDER BY c.rank ASC, c.score DESC, m.updated_at DESC, m.key ASC
				 LIMIT ?`
      )
      .all(spaceId, normalizeLimit(limit, 50)) as Array<AgentMemoryRow & { score: number }>;
    return rows.map((row) => ({ ...rowToEntry(row), score: row.score }));
  }

  private listSpaceIdsWithMemories(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT space_id FROM space_agent_memory ORDER BY space_id ASC`)
      .all() as Array<{ space_id: string }>;
    return rows.map((row) => row.space_id);
  }

  private mergeDuplicateMemories(spaceId: string, threshold: number): number {
    // Duplicate merging is scoped per owner so one agent's private memory is
    // never folded into another's (or into the shared pool). Each owner
    // namespace — including the shared '' namespace — is deduped independently.
    const owners = this.db
      .prepare(`SELECT DISTINCT owner_agent_id AS o FROM space_agent_memory WHERE space_id = ?`)
      .all(spaceId) as Array<{ o: string }>;
    let merged = 0;
    for (const { o } of owners) {
      merged += this.mergeDuplicateMemoriesForOwner(spaceId, o, threshold);
    }
    return merged;
  }

  private mergeDuplicateMemoriesForOwner(
    spaceId: string,
    ownerAgentId: string,
    threshold: number
  ): number {
    const initialRows = this.db
      .prepare(
        `SELECT * FROM space_agent_memory
				 WHERE space_id = ? AND owner_agent_id = ?
				 ORDER BY updated_at DESC, key ASC
				 LIMIT ?`
      )
      .all(spaceId, ownerAgentId, DUPLICATE_COMPARISON_LIMIT) as AgentMemoryRow[];
    const deletedIds = new Set<number>();
    const touchedIds = new Set<number>();
    let merged = 0;

    for (const candidate of initialRows) {
      if (deletedIds.has(candidate.id)) continue;
      let target = this.readRowById(candidate.id);
      if (!target) continue;
      for (const otherCandidate of initialRows) {
        if (otherCandidate.id === target.id || deletedIds.has(otherCandidate.id)) continue;
        const other = this.readRowById(otherCandidate.id);
        if (!other) continue;
        const similarity = jaccardSimilarity(
          memoryTokens(target.content),
          memoryTokens(other.content)
        );
        if (similarity < threshold) continue;

        const mergeTarget = chooseMergeTarget(target, other);
        const source = mergeTarget.id === target.id ? other : target;
        this.mergeMemoryRows(mergeTarget, source);
        deletedIds.add(source.id);
        touchedIds.add(mergeTarget.id);
        merged++;
        if (source.id === target.id) break;
        target = this.readRowById(mergeTarget.id) ?? mergeTarget;
      }
    }

    for (const id of touchedIds) {
      const row = this.readRowById(id);
      if (row) this.updateEmbedding(row);
    }

    return merged;
  }

  private readRowById(id: number): AgentMemoryRow | null {
    return (
      (this.db.prepare(`SELECT * FROM space_agent_memory WHERE id = ?`).get(id) as
        | AgentMemoryRow
        | undefined) ?? null
    );
  }

  private mergeMemoryRows(target: AgentMemoryRow, source: AgentMemoryRow): void {
    const currentTarget = this.readRowById(target.id) ?? target;
    const currentSource = this.readRowById(source.id) ?? source;
    const tags = normalizeTags([
      ...parseTags(currentTarget.tags),
      ...parseTags(currentSource.tags),
    ]);
    const content = mergeMemoryContent(currentTarget.content, currentSource.content);
    const updatedAt = Math.max(currentTarget.updated_at, currentSource.updated_at);
    const lastAccessedAt = maxNullable(
      currentTarget.last_accessed_at,
      currentSource.last_accessed_at
    );
    this.db
      .prepare(
        `UPDATE space_agent_memory
				 SET content = ?, tags = ?, updated_at = ?, access_count = ?, last_accessed_at = ?,
					embedding_status = 'pending', embedding_model = NULL, embedding_updated_at = NULL,
					embedding_error = NULL, embedding_revision = embedding_revision + 1, embedding_token = ?
				 WHERE id = ?`
      )
      .run(
        content,
        serializeTags(tags),
        updatedAt,
        currentTarget.access_count + currentSource.access_count,
        lastAccessedAt,
        crypto.randomUUID(),
        currentTarget.id
      );
    this.db.prepare(`DELETE FROM space_agent_memory WHERE id = ?`).run(currentSource.id);
  }

  private pruneStaleMemories(spaceId: string, ttlMs: number): number {
    if (ttlMs <= 0) return 0;
    const cutoff = Date.now() - ttlMs;
    const staleRows = this.db
      .prepare(
        `SELECT id FROM space_agent_memory
				 WHERE space_id = ?
					AND (last_accessed_at IS NULL OR last_accessed_at < ?)
					AND updated_at < ?
					AND (access_count = 0 OR last_accessed_at IS NOT NULL)`
      )
      .all(spaceId, cutoff, cutoff) as Array<{ id: number }>;
    if (staleRows.length === 0) return 0;
    for (let offset = 0; offset < staleRows.length; offset += STALE_DELETE_BATCH_SIZE) {
      const batch = staleRows.slice(offset, offset + STALE_DELETE_BATCH_SIZE);
      this.db
        .prepare(`DELETE FROM space_agent_memory WHERE id IN (${batch.map(() => '?').join(', ')})`)
        .run(...batch.map((row) => row.id));
    }
    return staleRows.length;
  }

  private refreshCoreMemories(spaceId: string, limit: number): number {
    const now = Date.now();
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM space_agent_memory
					 WHERE space_id = ?
						AND access_count > 0`
        )
        .all(spaceId) as AgentMemoryRow[]
    )
      // Core memories are the Space's shared "common knowledge". Only shared
      // (space-scoped) rows are eligible — an agent's private hot memory must
      // not surface in the shared core ranking.
      .filter((row) => row.owner_agent_id === '')
      .map((row) => ({ row, score: coreMemoryScore(row) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.row.last_accessed_at ?? right.row.updated_at) -
            (left.row.last_accessed_at ?? left.row.updated_at) ||
          left.row.key.localeCompare(right.row.key)
      )
      .slice(0, limit);

    this.db.prepare(`DELETE FROM space_agent_core_memory WHERE space_id = ?`).run(spaceId);
    const insert = this.db.prepare(
      `INSERT INTO space_agent_core_memory (space_id, memory_id, score, rank, updated_at)
			 VALUES (?, ?, ?, ?, ?)`
    );
    for (const [index, item] of rows.entries()) {
      insert.run(spaceId, item.row.id, item.score, index + 1, now);
    }
    return rows.length;
  }

  private async searchWithOptions(
    spaceId: string,
    query: string,
    options?: {
      limit?: number;
      offset?: number;
      maxLimit?: number;
      ownerAgentId?: string | null;
      scope?: AgentMemoryScopeFilter;
    }
  ): Promise<AgentMemorySearchRow[]> {
    const ftsQuery = buildFtsQuery(query);
    const limit = normalizeLimit(options?.limit ?? 10, options?.maxLimit ?? 20);
    const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
    const candidateLimit = options?.maxLimit ?? VECTOR_CANDIDATE_LIMIT;
    const poolLimit = Math.max(candidateLimit, limit + offset);
    const ownerFilter = buildOwnerFilter(options?.ownerAgentId, options?.scope);

    const ftsRows = ftsQuery ? this.searchFts(spaceId, ftsQuery, poolLimit, 0, ownerFilter) : [];
    const vectorRows = await this.searchVector(spaceId, query, poolLimit, ownerFilter);
    const rows = mergeRankedRows(ftsRows, vectorRows).slice(offset, offset + limit);

    if (rows.length > 0) {
      const now = Date.now();
      // Bump by row id so access telemetry hits the exact namespace-scoped row
      // (multiple rows can now share a key across owners).
      const bump = this.db.prepare(
        `UPDATE space_agent_memory
				 SET access_count = access_count + 1, last_accessed_at = ?
				 WHERE id = ?`
      );
      const updateAccess = this.db.transaction((items: AgentMemorySearchRow[]) => {
        for (const row of items) bump.run(now, row.id);
      });
      updateAccess(rows);
      this.reactiveDb?.notifyChange('space_agent_memory');
    }

    return rows;
  }

  private searchFts(
    spaceId: string,
    ftsQuery: string,
    limit: number,
    offset: number,
    ownerFilter: OwnerFilter
  ): AgentMemorySearchRow[] {
    return this.db
      .prepare(
        `SELECT m.*, bm25(space_agent_memory_fts) AS rank
				 FROM space_agent_memory_fts
				 JOIN space_agent_memory m ON m.id = space_agent_memory_fts.rowid
				 WHERE space_agent_memory_fts MATCH ? AND m.space_id = ?
				 ${ownerFilter.clause ? `AND ${ownerFilter.clause}` : ''}
				 ORDER BY rank ASC, m.updated_at DESC, m.key ASC
				 LIMIT ? OFFSET ?`
      )
      .all(ftsQuery, spaceId, ...ownerFilter.params, limit, offset) as AgentMemorySearchRow[];
  }

  private async searchVector(
    spaceId: string,
    query: string,
    limit: number,
    ownerFilter: OwnerFilter
  ): Promise<RankedRow[]> {
    const queryVector = await this.embedText(query, 'query', { fallbackToNull: true });
    if (!queryVector || !this.embedder) return [];

    const rows = this.db
      .prepare(
        `SELECT m.*, v.embedding, v.dimensions, v.model
				 FROM memory_vectors v
				 JOIN space_agent_memory m ON m.id = v.memory_id
				 WHERE m.space_id = ?
					AND m.embedding_status = 'ready'
					AND v.model = ?
					and v.dimensions = ?
					${ownerFilter.clause ? `AND ${ownerFilter.clause}` : ''}`
      )
      .all(
        spaceId,
        this.embedder.model,
        this.embedder.dimensions,
        ...ownerFilter.params
      ) as AgentMemoryVectorRow[];

    return rows
      .map((row) => {
        const similarity = cosineSimilarity(queryVector, blobToFloat32Array(row.embedding));
        return {
          row: { ...row, rank: 1 - similarity },
          rank: similarity,
        };
      })
      .filter((item) => Number.isFinite(item.rank))
      .sort(
        (a, b) =>
          b.rank - a.rank ||
          b.row.updated_at - a.row.updated_at ||
          a.row.key.localeCompare(b.row.key)
      )
      .slice(0, limit);
  }

  backfillPendingEmbeddings(): void {
    if (!this.embedder) return;
    void this.backfillEmbeddingBatches();
  }

  private async backfillEmbeddingBatches(): Promise<void> {
    if (!this.embedder) return;
    const attemptedMemoryIds = new Set<number>();
    for (;;) {
      const attemptedIds = [...attemptedMemoryIds];
      const attemptedFilter = attemptedIds.length
        ? `AND m.id NOT IN (${attemptedIds.map(() => '?').join(', ')})`
        : '';
      const rows = this.db
        .prepare(
          `SELECT m.*
					 FROM space_agent_memory m
					 LEFT JOIN memory_vectors v ON v.memory_id = m.id
					 WHERE (
						m.embedding_status IN ('pending', 'failed')
						OR v.memory_id IS NULL
						OR v.model != ?
						OR v.dimensions != ?
					 )
					 ${attemptedFilter}
					 ORDER BY m.updated_at ASC, m.key ASC
					 LIMIT ?`
        )
        .all(
          this.embedder.model,
          this.embedder.dimensions,
          ...attemptedIds,
          EMBEDDING_BACKFILL_BATCH_SIZE
        ) as AgentMemoryRow[];
      if (rows.length === 0) return;
      for (const row of rows) {
        attemptedMemoryIds.add(row.id);
        await this.updateEmbedding(row);
      }
    }
  }

  private updateEmbedding(row: AgentMemoryRow): Promise<void> | void {
    const sourceRevision = row.embedding_revision;
    const sourceToken = row.embedding_token;
    try {
      const embedding = this.embedText(memoryEmbeddingText(row), 'passage');
      if (!embedding) return;
      if (embedding instanceof Promise) {
        return embedding
          .then((vector) => this.storeEmbedding(row.id, sourceRevision, sourceToken, vector))
          .catch((error: unknown) =>
            this.markEmbeddingFailed(row.id, sourceRevision, sourceToken, error)
          );
      }
      this.storeEmbedding(row.id, sourceRevision, sourceToken, embedding);
    } catch (error) {
      this.markEmbeddingFailed(row.id, sourceRevision, sourceToken, error);
    }
  }

  private storeEmbedding(
    memoryId: number,
    sourceRevision: number,
    sourceToken: string,
    embedding: Float32Array
  ): void {
    const now = Date.now();
    const store = this.db.transaction(() => {
      const current = this.db
        .prepare(`SELECT embedding_revision, embedding_token FROM space_agent_memory WHERE id = ?`)
        .get(memoryId) as { embedding_revision: number; embedding_token: string } | undefined;
      if (
        !current ||
        current.embedding_revision !== sourceRevision ||
        current.embedding_token !== sourceToken
      )
        return;

      this.db
        .prepare(
          `INSERT INTO memory_vectors (memory_id, embedding, dimensions, model, updated_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(memory_id) DO UPDATE SET
						embedding = excluded.embedding,
						dimensions = excluded.dimensions,
						model = excluded.model,
						updated_at = excluded.updated_at`
        )
        .run(
          memoryId,
          float32ArrayToBlob(embedding),
          embedding.length,
          this.embedder?.model ?? 'unknown',
          now
        );
      this.db
        .prepare(
          `UPDATE space_agent_memory
					 SET embedding_status = 'ready', embedding_model = ?, embedding_updated_at = ?, embedding_error = NULL
					 WHERE id = ? AND embedding_revision = ? AND embedding_token = ?`
        )
        .run(this.embedder?.model ?? 'unknown', now, memoryId, sourceRevision, sourceToken);
    });
    store();
  }

  private markEmbeddingFailed(
    memoryId: number,
    sourceRevision: number,
    sourceToken: string,
    error: unknown
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE space_agent_memory
				 SET embedding_status = 'failed', embedding_model = ?, embedding_updated_at = ?, embedding_error = ?
				 WHERE id = ? AND embedding_revision = ? AND embedding_token = ?`
      )
      .run(
        this.embedder?.model ?? 'unknown',
        now,
        embeddingErrorMessage(error),
        memoryId,
        sourceRevision,
        sourceToken
      );
  }

  private embedText(
    text: string,
    kind: 'query' | 'passage'
  ): Float32Array | Promise<Float32Array> | null;
  private embedText(
    text: string,
    kind: 'query' | 'passage',
    options: { fallbackToNull: true }
  ): Float32Array | Promise<Float32Array | null> | null;
  private embedText(
    text: string,
    kind: 'query' | 'passage',
    options?: { fallbackToNull?: boolean }
  ): Float32Array | Promise<Float32Array | null> | null {
    if (!this.embedder) return null;
    try {
      const embedding =
        kind === 'query' ? this.embedder.embedQuery(text) : this.embedder.embedPassage(text);
      if (embedding instanceof Promise) {
        const normalized = embedding.then((value) => this.normalizeEmbedding(value));
        return options?.fallbackToNull ? normalized.catch(() => null) : normalized;
      }
      return this.normalizeEmbedding(embedding);
    } catch (error) {
      if (options?.fallbackToNull) return null;
      throw error;
    }
  }

  private normalizeEmbedding(embedding: Float32Array | number[]): Float32Array {
    const vector = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    if (vector.length !== this.embedder?.dimensions)
      throw new Error('Embedding dimension mismatch.');
    return vector;
  }
}

function rowToEntry(row: AgentMemoryRow): AgentMemoryEntry {
  return {
    key: row.key,
    spaceId: row.space_id,
    // The empty string is the space-scoped sentinel at the storage layer; expose
    // it as null in the public entry type.
    ownerAgentId: row.owner_agent_id || null,
    scope: row.scope,
    content: row.content,
    tags: parseTags(row.tags),
    createdBySession: row.created_by_session,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
  };
}

function chooseMergeTarget(left: AgentMemoryRow, right: AgentMemoryRow): AgentMemoryRow {
  if (left.access_count !== right.access_count) {
    return left.access_count > right.access_count ? left : right;
  }
  const leftAccess = left.last_accessed_at ?? 0;
  const rightAccess = right.last_accessed_at ?? 0;
  if (leftAccess !== rightAccess) return leftAccess > rightAccess ? left : right;
  if (left.updated_at !== right.updated_at)
    return left.updated_at > right.updated_at ? left : right;
  return left.key.localeCompare(right.key) <= 0 ? left : right;
}

function mergeMemoryContent(left: string, right: string): string {
  if (left === right || left.includes(right)) return left;
  if (right.includes(left)) return right;
  const merged = `${left}\n\n${right}`;
  if (merged.length <= MEMORY_CONTENT_MAX_LENGTH) return normalizeContent(merged);
  return normalizeContent(`${merged.slice(0, MEMORY_CONTENT_MAX_LENGTH - 1).trimEnd()}…`);
}

function memoryTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .filter((token) => token.length >= 3)
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function coreMemoryScore(row: AgentMemoryRow): number {
  const lastTouched = row.last_accessed_at ?? row.updated_at;
  const ageDays = Math.max(0, (Date.now() - lastTouched) / (24 * 60 * 60 * 1000));
  return row.access_count / (1 + ageDays);
}

interface OwnerFilter {
  /** SQL fragment referencing the table alias, or '' for no filtering. */
  clause: string;
  params: string[];
}

/**
 * Build a `WHERE` fragment that selects which owner namespaces a read may see.
 *
 * - `scope='all'` → every row.
 * - `scope='space'` (or no owner context) → shared rows only (`owner = ''`).
 * - `scope='mine'` → only the caller's rows (nothing when there is no owner).
 * - default → caller's rows + shared rows (the natural agent view).
 *
 * The empty-string sentinel keeps every branch a plain equality/IN predicate —
 * no IS NULL special-casing. `alias` lets callers target `m.owner_agent_id` or
 * the unqualified column.
 */
function buildOwnerFilter(
  ownerAgentId: string | null | undefined,
  scope: AgentMemoryScopeFilter | undefined,
  alias = 'm'
): OwnerFilter {
  const col = `${alias}.owner_agent_id`;
  const owner = (ownerAgentId ?? '').trim();
  if (scope === 'all') return { clause: '', params: [] };
  if (scope === 'mine') {
    if (!owner) return { clause: '0', params: [] };
    return { clause: `${col} = ?`, params: [owner] };
  }
  if (scope === 'space') return { clause: `${col} = ''`, params: [] };
  // default (mine + space)
  if (!owner) return { clause: `${col} = ''`, params: [] };
  return { clause: `${col} IN (?, '')`, params: [owner] };
}

function mergeRankedRows(
  ftsRows: AgentMemorySearchRow[],
  vectorRows: RankedRow[]
): AgentMemorySearchRow[] {
  const merged = new Map<number, { row: AgentMemorySearchRow; score: number }>();

  ftsRows.forEach((row, index) => {
    merged.set(row.id, {
      row,
      score: 1 / (RRF_K + index + 1),
    });
  });

  vectorRows.forEach((item, index) => {
    const existing = merged.get(item.row.id);
    const score = 1 / (RRF_K + index + 1);
    if (existing) {
      existing.score += score;
    } else {
      merged.set(item.row.id, { row: item.row, score });
    }
  });

  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updated_at - a.row.updated_at ||
        a.row.key.localeCompare(b.row.key)
    )
    .map((item) => ({ ...item.row, rank: item.score }));
}

function memoryEmbeddingText(row: AgentMemoryRow): string {
  return [row.key, row.content, ...parseTags(row.tags)].join('\n');
}

function float32ArrayToBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function blobToFloat32Array(blob: Buffer): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    Math.floor(blob.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY;
  const length = left.length;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NEGATIVE_INFINITY;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function embeddingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, EMBEDDING_ERROR_MAX_LENGTH);
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Memory key must be a non-empty string.');
  if (trimmed.length > 200) throw new Error('Memory key must be 200 characters or fewer.');
  return trimmed;
}

function normalizeContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Memory content must be a non-empty string.');
  if (trimmed.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new Error(`Memory content must be ${MEMORY_CONTENT_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function normalizeTags(tags: string[]): string[] {
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    // Tags are rendered verbatim into agent prompts via `tags.join(', ')`, so a
    // single oversized tag would balloon the prompt past the memory-content cap.
    // Bound per-tag length here to keep the prompt-size budget enforceable.
    if (tag.length > MEMORY_TAG_MAX_LENGTH) {
      throw new Error(`Memory tags must be ${MEMORY_TAG_MAX_LENGTH} characters or fewer.`);
    }
    normalized.push(tag);
  }
  return [...new Set(normalized)].slice(0, MEMORY_TAG_MAX_COUNT);
}

function serializeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

function parseTags(tags: string): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((tag): tag is string => typeof tag === 'string');
    }
  } catch {
    // Pre-JSON rows used whitespace-delimited tags.
  }
  return tags.split(/\s+/).filter(Boolean);
}

function normalizeLimit(limit: number, max = 20): number {
  if (!Number.isFinite(limit)) return Math.min(10, max);
  return Math.min(Math.max(1, Math.trunc(limit)), max);
}

function buildFtsQuery(query: string): string | null {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    // Preserve hyphens, dots, slashes, and colons so paths, URLs, and
    // dashed identifiers (e.g. `src/lib/main.ts`, `pre-commit`) remain
    // intact for trigram matching.
    .map((term) => term.replace(/[^\p{L}\p{N}_./:-]/gu, ''))
    // Trigram FTS cannot match terms shorter than three chars.
    .filter((term) => term.length >= 3);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ');
}
