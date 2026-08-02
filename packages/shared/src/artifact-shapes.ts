/**
 * Generic Artifact Shapes
 *
 * A SHAPE is a closed, domain-agnostic STRUCTURE vocabulary that the workflow
 * infra knows. A KIND is a freeform semantic label that the domain layer
 * supplies. A PR, an issue, and a preview page are all the `link` shape with
 * different `kind` values; infra never names `pr` / `review` / etc — those are
 * kinds, supplied by the coding-workflow layer.
 *
 * Shape = STRUCTURE (infra vocabulary, closed). Kind = SEMANTIC LABEL (domain,
 * extensible). Per-shape contracts live below; identity rules (one-per-run vs
 * multi-keyed) live in `deriveArtifactKey`.
 *
 * This module is pure (no zod, no I/O) so both daemon and web can depend on it.
 */

// ── Closed shape vocabulary ──────────────────────────────────────────────────

/**
 * The closed set of generic artifact shapes known to infra. `save_artifact`
 * validates against this set and rejects anything outside it.
 *
 * - `link`       — a URL the run produced or references (PR, issue, preview…)
 * - `commit_set` — a set of commits (repo, branch, head, +/- counts)
 * - `check`      — a named check with a status (CI run, test suite, validation)
 * - `metric`     — a named numeric measurement (stars, latency, error count)
 * - `decision`   — a recommendation/verdict (review outcome, gate approval)
 * - `note`       — a short rolling status line (single upsert) or timestamp
 */
export const ARTIFACT_SHAPES = [
  'link',
  'commit_set',
  'check',
  'metric',
  'decision',
  'note',
] as const;

export type ArtifactShape = (typeof ARTIFACT_SHAPES)[number];

// ── Per-shape data contracts ─────────────────────────────────────────────────
//
// `kind` appears on every shape as the optional semantic hint. Identity keys
// fold `kind` in where it distinguishes instances of the same shape (e.g. one
// `link` per kind).

/** `link` — a URL the run produced or references. */
export interface LinkArtifactData {
  url: string;
  title?: string;
  /** Semantic hint, freeform: 'pr' | 'issue' | 'preview' | 'doc' | 'post' … */
  kind?: string;
  /** PR-specific hint carried for convenience (open/merged/closed). */
  state?: string;
  /** PR / issue number, when relevant. */
  number?: number;
}

/** `commit_set` — a set of commits on a branch. */
export interface CommitSetArtifactData {
  repo?: string;
  branch?: string;
  head?: string;
  commits?: Array<{ sha: string; message?: string; author?: string }>;
  additions?: number;
  deletions?: number;
  kind?: string;
}

/** `check` — a named check with a status. */
export interface CheckArtifactData {
  /** Identity key (e.g. 'ci', 'unit-tests'). */
  name: string;
  /** 'pass' | 'fail' | 'running' | 'pending' | 'unknown' (freeform). */
  status: string;
  /** Bucketed counts, e.g. { passed: 40, failed: 1, skipped: 3 }. */
  counts?: Record<string, number>;
  url?: string;
  kind?: string;
}

/** `metric` — a named numeric measurement. */
export interface MetricArtifactData {
  /** Identity key (e.g. 'p95-latency', 'stars'). */
  name: string;
  value: number | string;
  unit?: string;
  target?: number | string;
  kind?: string;
}

/** `decision` — a recommendation/verdict. May be multi per run (keyed by round). */
export interface DecisionArtifactData {
  /** 'approve' | 'request_changes' | 'reject' | 'approved' | 'reviewed' … */
  recommendation: string;
  /** ≤1 sentence human summary. */
  summary?: string;
  /** Bucketed counts, e.g. { p0: 0, p1: 2 }. */
  counts?: Record<string, number>;
  /** Semantic hint: 'review' | 'gate' | … */
  kind?: string;
}

/** `note` — a short rolling status line (single upsert) or timestamp. */
export interface NoteArtifactData {
  /** Status prose. Legacy callers pass `summary` instead; both are accepted. */
  text?: string;
  /** Alias of `text`; kept so legacy `{ summary }` writes render correctly. */
  summary?: string;
  /** ISO timestamp. */
  ts?: string;
  kind?: string;
}

export type ArtifactShapeData =
  | LinkArtifactData
  | CommitSetArtifactData
  | CheckArtifactData
  | MetricArtifactData
  | DecisionArtifactData
  | NoteArtifactData;

// ── Legacy compatibility ─────────────────────────────────────────────────────

/**
 * Maps pre-shape freeform `artifactType` values to the new generic shape. Used
 * by `save_artifact` (for in-flight agents still emitting `{ type }`) and by the
 * one-time backfill migration. Unknown legacy types return `undefined` — the
 * closed set is still enforced.
 *
 * `result` was overloaded in the old model, so the mapping is data-aware: a
 * `result` with a `summary` (the common QA/completion case, which may also carry
 * a `pr_url`) stays a `decision` so completion readers can recover the outcome;
 * a URL-only `result` (no summary) becomes a `link`. `review` is a `decision`;
 * `progress` is a `note`; `pr` is a `link`. Callers should skip strict shape
 * validation for legacy-mapped writes — they predate the per-shape contracts.
 */
export function resolveLegacyShape(
  type: string,
  data: Record<string, unknown> | undefined
): ArtifactShape | undefined {
  switch (type) {
    case 'pr':
      return 'link';
    case 'progress':
      return 'note';
    case 'review':
      return 'decision';
    case 'result': {
      const d = data ?? {};
      const hasSummary = typeof d.summary === 'string' && d.summary.length > 0;
      const hasUrl =
        typeof d.url === 'string' ||
        typeof d.pr_url === 'string' ||
        typeof d.prUrl === 'string' ||
        typeof d.review_url === 'string';
      // A summary is the important payload (QA outcome / completion note) and
      // must stay visible to decision readers, so prefer decision when present.
      // Only a URL-only result becomes a pure link.
      return hasUrl && !hasSummary ? 'link' : 'decision';
    }
    default:
      return undefined;
  }
}

export function isArtifactShape(value: unknown): value is ArtifactShape {
  return typeof value === 'string' && (ARTIFACT_SHAPES as readonly string[]).includes(value);
}

/**
 * For a legacy row being treated as a `link`, copy the URL-bearing field onto
 * `data.url` so link readers (which key off `data.url`) find it. Returns a new
 * data object; no-op when `data.url` is already set or no URL field is present.
 */
export function normalizeLinkData(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.url === 'string' && data.url) return data;
  const url =
    (typeof data.pr_url === 'string' && data.pr_url) ||
    (typeof data.prUrl === 'string' && data.prUrl) ||
    (typeof data.review_url === 'string' && data.review_url);
  if (!url) return data;
  return { ...data, url };
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Derive the artifact identity key (`artifact_key`) for a shape from its data.
 *
 * The DB upserts on `(run_id, node_id, artifact_type, artifact_key)`, so the
 * key encodes "is this one-per-run or multi". Rules:
 *   - `note`       → 'current'              (single upsert per node; rolling status)
 *   - `link`       → kind || 'default'      (one per kind: pr, issue, preview…)
 *   - `commit_set` → branch || 'default'    (one per branch)
 *   - `check`      → name                   (one per named check)
 *   - `metric`     → name                   (one per named metric)
 *   - `decision`   → explicitKey||kind||'current'
 *                                            (default single terminal; pass an
 *                                             explicit key like 'round-0' for
 *                                             multi-round review history)
 *
 * `explicitKey` is honored ONLY for `decision` (the one shape with a legitimate
 * multi-instance key). For every other shape the key is always derived, so a
 * caller cannot smuggle in `key: 'round-N'` to create unlimited `note` rows.
 */
export function deriveArtifactKey(
  shape: ArtifactShape,
  data: Record<string, unknown>,
  explicitKey?: string
): string {
  const kind = typeof data.kind === 'string' && data.kind ? data.kind : '';
  switch (shape) {
    case 'note':
      return 'current';
    case 'link':
      return kind || 'default';
    case 'commit_set': {
      const branch = typeof data.branch === 'string' && data.branch ? data.branch : '';
      return branch || 'default';
    }
    case 'check':
    case 'metric': {
      const name = typeof data.name === 'string' && data.name ? data.name : '';
      return name || 'default';
    }
    case 'decision':
      // Only decision honors an explicit (multi-round) key. Namespace it by
      // kind so two decision streams (e.g. kind:'review' round-0 and
      // kind:'gate' round-0) never collapse onto the same row.
      if (explicitKey) return kind ? `${kind}:${explicitKey}` : explicitKey;
      return kind || 'current';
    default:
      return 'current';
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ArtifactValidation = { ok: true } | { ok: false; error: string };

/** True when `value` is a non-empty string. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate `data` against the per-shape contract. Returns `{ ok: false, error }`
 * when a required field is missing. This is the gate `save_artifact` enforces —
 * it is deliberately lenient about optional fields so the closed set can grow
 * without breaking older callers.
 */
export function validateArtifactShape(
  shape: ArtifactShape,
  data: Record<string, unknown>
): ArtifactValidation {
  switch (shape) {
    case 'link':
      if (!nonEmptyString(data.url)) {
        return { ok: false, error: "shape 'link' requires data.url (the URL)." };
      }
      return { ok: true };
    case 'check':
      if (!nonEmptyString(data.name)) {
        return { ok: false, error: "shape 'check' requires data.name (the check identity)." };
      }
      if (!nonEmptyString(data.status)) {
        return { ok: false, error: "shape 'check' requires data.status." };
      }
      return { ok: true };
    case 'metric':
      if (!nonEmptyString(data.name)) {
        return { ok: false, error: "shape 'metric' requires data.name (the metric identity)." };
      }
      // value must be a scalar measurement (number | string), not an
      // array/object/boolean.
      if (
        data.value === undefined ||
        data.value === null ||
        (typeof data.value !== 'number' && typeof data.value !== 'string')
      ) {
        return {
          ok: false,
          error: "shape 'metric' requires data.value to be a number or string.",
        };
      }
      return { ok: true };
    case 'decision':
      if (!nonEmptyString(data.recommendation)) {
        return {
          ok: false,
          error: "shape 'decision' requires data.recommendation (e.g. 'approve').",
        };
      }
      return { ok: true };
    case 'commit_set':
      // No hard-required field — a commit set may be just { branch, head }.
      return { ok: true };
    case 'note':
      // Must carry something to store: a status line (text/summary) or a
      // bare timestamp (ts) for event-marker notes.
      if (!nonEmptyString(data.text) && !nonEmptyString(data.summary) && !nonEmptyString(data.ts)) {
        return { ok: false, error: "shape 'note' requires data.text, data.summary, or data.ts." };
      }
      return { ok: true };
    default:
      return { ok: false, error: `Unknown shape '${shape as string}'.` };
  }
}
