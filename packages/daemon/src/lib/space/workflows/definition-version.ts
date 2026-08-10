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
 * Non-behavioral fields are excluded so two writes producing identical behavioral content
 * share a version: `createdAt`/`updatedAt` (volatile timestamps — a no-op re-stamp that
 * only bumps `updatedAt` must not version), `layout` (visual node positions — a node-drag
 * is not a behavioral change), and `templateHash` (a derived drift-detection fingerprint,
 * settable independently of content via `updateWorkflow`'s `templateHash` param, not
 * behavior the kernel executes).
 *
 * Determinism contract (for the Phase-1 read cutover): the payload is the RAW persisted
 * definition — `SpaceWorkflowRepository.getWorkflow()` output, BEFORE any
 * `SpaceWorkflowManager` sanitization (e.g. `postApproval` normalization). The chosen model
 * is **sanitize-at-rehydrate**: the cutover applies the same sanitization the kernel applies
 * to a live read when it resolves a pinned run to its version, so "this run reads version V"
 * is well-defined regardless of whether a given read site goes through the manager or the
 * raw repo (see `SpaceWorkflowManager.getWorkflowForRun`).
 *
 * Versions are computed and appended on every definition write. The Phase-1 read cutover
 * resolves a pinned run to its creation-time version via `getWorkflowForRun` (manager,
 * sanitized) / `SpaceWorkflowRepository.getWorkflowForRun` (raw), so a later edit to the
 * mutable head cannot change what an in-flight run executes.
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
  // Strip non-behavioral fields so the hash captures only what the kernel executes:
  // createdAt/updatedAt (volatile), layout (visual node positions — a node-drag is not a
  // behavioral change), and templateHash (a derived drift-detection fingerprint, settable
  // independently of content, not behavior).
  const copy: Record<string, unknown> = { ...workflow };
  delete copy.createdAt;
  delete copy.updatedAt;
  delete copy.layout;
  delete copy.templateHash;
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

/**
 * A deterministic 32-bit timestamp-substitute derived from a definition version hash. The
 * Phase-1 read cutover rehydrates a pinned run's `updatedAt` with this value so the
 * gate-open cache fingerprint (`updatedAt + gateDef hash`, `generateGateFingerprint`) is
 * STABLE for a pinned definition — identical on first activation and on recovery — because
 * it depends only on the immutable version identity, not on when the version row was
 * appended. That matters because `appendVersion` is `INSERT OR IGNORE`: a reused hash
 * (A→B→A edit, or a row left from the pre-cutover release) keeps its original `created_at`
 * and discards a newly supplied timestamp, so deriving the fingerprint from the row's
 * timestamp would diverge between initial and recovered reads. The value is used solely as
 * a fingerprint basis (no execution code reads the rehydrated `updatedAt` otherwise), so it
 * need only be stable and collision-light per version.
 */
export function stableVersionTimestamp(versionHash: string): number {
  let h = 0;
  for (let i = 0; i < versionHash.length; i++) {
    h = (Math.imul(31, h) + versionHash.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * The gate-definition hash component of `ChannelRouter.generateGateFingerprint` (extracted
 * so the cutover re-key reproduces the exact post-cutover fingerprint). A fast
 * non-cryptographic 32-bit hash, suitable only for cache invalidation.
 *
 * ORDER-INDEPENDENT (uses `stableStringify`, keys sorted): the runtime and the re-key each
 * resolve a sanitized gate, and making the hash insensitive to key order means a future
 * refactor can't silently break the gate-open cache match by comparing gates whose keys were
 * materialized in different orders (e.g. a stableStringify-roundtripped pinned gate vs an
 * insertion-order head gate). `legacyGateDefinitionHash` is the order-sensitive counterpart
 * kept for the one place that must match historical, pre-cutover stored values.
 */
export function gateDefinitionHash(gate: unknown): number {
  return hashJson(stableStringify(gate));
}

/**
 * The ORDER-SENSITIVE (bare `JSON.stringify`) gate hash — the exact hash the pre-cutover
 * `generateGateFingerprint` used to compute the stored gate-open fingerprints. Used ONLY by
 * the cutover validity guard (`gate-cache-rekey.ts`), which must reproduce those historical
 * stored values to decide whether an entry is still valid for the current head. Everywhere
 * else uses the order-independent `gateDefinitionHash`.
 */
export function legacyGateDefinitionHash(gate: unknown): number {
  return hashJson(JSON.stringify(gate));
}

/** Fast non-cryptographic 32-bit hash of a string (the historical inline fingerprint hash). */
function hashJson(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

/**
 * The gate-open cache fingerprint a pinned run uses post-cutover:
 * `stableVersionTimestamp(versionHash) + gateDefinitionHash(gate)`. The startup backfill
 * re-keys a backfilled run's existing persisted gate-open entries to this value, so the
 * cache survives the cutover (the basis switches from the live head's `updatedAt` to the
 * immutable version hash) WITHOUT re-evaluating gates.
 */
export function pinnedGateFingerprint(versionHash: string, gate: unknown): number {
  return stableVersionTimestamp(versionHash) + gateDefinitionHash(gate);
}
