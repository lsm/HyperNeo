/**
 * Definition versioning — content-hash identity for workflow definitions.
 *
 * Phase 1 of the data-defined workflow engine (RFC §4, `docs/design/workflow-engine-rfc.md`).
 * A `definition_version` is a deterministic SHA-256 of a definition's behavioral content,
 * used as the immutable identity of a row in `space_workflow_definition_versions`. It lets
 * a run be pinned to the exact definition it was created with, immune to later edits.
 *
 * This is distinct from `template_hash` (template-hash.ts): the template hash is
 * *template-portable* — it excludes per-space agent UUIDs so the same built-in template
 * hashes identically across spaces. A definition version captures the *actual persisted
 * definition of one row* (resolved agent IDs, user edits, per-node config), because that
 * is exactly what a pinned run must re-read byte-for-byte.
 *
 * Volatile non-behavioral metadata (`createdAt`, `updatedAt`) is excluded so two writes
 * producing identical behavioral content share a version — a no-op re-stamp that only
 * bumps `updatedAt` does NOT create a new version row.
 *
 * Determinism contract (for the Phase-1 read cutover): the payload is the RAW persisted
 * definition — `SpaceWorkflowRepository.getWorkflow()` output, BEFORE any
 * `SpaceWorkflowManager` sanitization (e.g. `postApproval` normalization). The chosen model
 * is **sanitize-at-rehydrate**: when the cutover resolves a pinned run to its version, it
 * must apply the same sanitization the kernel applies to a live read, so "this run reads
 * version V" is well-defined regardless of whether a given read site goes through the
 * manager or the raw repo. Pinning down that read path uniformly (or switching to
 * sanitize-at-record) is cutover-PR scope; until then the payload faithfully captures what
 * is stored, which is all shadow mode needs.
 *
 * Shadow mode (introduced in this PR): versions are computed and appended on every
 * definition write. No run read path resolves through them yet; the Phase-1 read cutover
 * (pinning a run to its creation-time version) lands in a later PR.
 */

import { createHash } from 'node:crypto';
import type { SpaceWorkflow } from '@hyperneo/shared';

/**
 * Deterministic JSON serialization: object keys sorted recursively. Makes the hash
 * independent of property insertion order, so an in-memory workflow and its DB round-trip
 * (which may reorder keys) hash identically. Mirrors `JSON.stringify` handling of
 * `undefined` (object keys with an `undefined` value are omitted; `undefined` array
 * elements render as `null`) so output is always valid JSON.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') {
    // Primitives. JSON.stringify(undefined) === undefined (invalid inside objects); the
    // persisted workflow carries no undefined own-properties, but be safe and render any
    // stray undefined as null rather than emitting invalid JSON.
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((el) => stableStringify(el));
    return `[${parts.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * The canonical payload stored (and hashed) for a definition version: the full persisted
 * SpaceWorkflow with volatile timestamps stripped. Returned as a plain record so the
 * stable serializer controls key order.
 */
function canonicalPayload(workflow: SpaceWorkflow): Record<string, unknown> {
  // Strip volatile non-behavioral timestamps so behaviorally-identical writes (e.g. a
  // no-op re-stamp that only bumps updatedAt) share a version.
  const copy: Record<string, unknown> = { ...workflow };
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

export interface ComputedDefinitionVersion {
  /** SHA-256 hex of the canonical payload. */
  versionHash: string;
  /** The canonical JSON the hash was derived from. Stored so a version row is self-contained. */
  payload: string;
}

/**
 * Compute the immutable version identity for a persisted workflow definition. The hash is
 * derived from the stored payload, so the two are always consistent: a version row can be
 * re-verified by re-hashing its payload.
 */
export function computeDefinitionVersion(workflow: SpaceWorkflow): ComputedDefinitionVersion {
  const payload = stableStringify(canonicalPayload(workflow));
  const versionHash = createHash('sha256').update(payload).digest('hex');
  return { versionHash, payload };
}
