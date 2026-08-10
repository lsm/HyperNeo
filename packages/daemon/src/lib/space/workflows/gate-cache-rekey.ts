/**
 * Phase-1 read-cutover gate-open cache re-key (RFC §4).
 *
 * A legacy in-flight run's persisted gate-open cache was fingerprinted with the OLD basis
 * (the live head's `updatedAt` + gate-def hash). After the cutover, the runtime reads the
 * run's PINNED definition and fingerprints it with the version-stable basis
 * (`stableVersionTimestamp(versionHash)` + gate-def hash). Without re-keying, every such
 * entry would mismatch and re-evaluate at the cutover — which a transient gate-script
 * failure could block.
 *
 * This sweep re-keys each persisted entry to the version-stable basis by hashing the SAME
 * sanitized gate the runtime read path fingerprints (`manager.getWorkflowForRun`), so the
 * cache survives the cutover without re-evaluation. It is idempotent and intended to run on
 * every startup, so a crash between pin and re-key recovers on the next boot.
 *
 * Validity guard: only entries that were VALID for the run's current head (pre-cutover) are
 * re-keyed. If the head was edited after the gate cached, the entry is stale (cached for an
 * older head) — promoting it would bypass re-evaluation and could skip a tightened gate, so
 * stale entries are left for the router to re-evaluate. Deleted-head orphans have no head to
 * compare against and are re-keyed unconditionally.
 */

import { Logger } from '../../logger';
import type { GateOpenStateRepository } from '../../../storage/repositories/gate-open-state-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import {
  legacyGateDefinitionHash,
  pinnedGateFingerprint,
  stableStringify,
  stableVersionTimestamp,
} from './definition-version';

const log = new Logger('gate-cache-rekey');

export interface GateCacheRekeyDeps {
  gateOpenStateRepo: GateOpenStateRepository;
  runRepo: SpaceWorkflowRunRepository;
  manager: SpaceWorkflowManager;
}

/** Re-key persisted gate-open entries for pinned runs to the version-stable fingerprint basis. */
export function rekeyPinnedGateOpenCaches(deps: GateCacheRekeyDeps): void {
  for (const entry of deps.gateOpenStateRepo.listAllOpenEntries()) {
    // Per-entry isolation — mirrors the sibling startup sweeps (backfillExistingDefinitionVersions,
    // backfillDefinitionPins): manager.getWorkflow/getWorkflowForRun run the throw-prone
    // rowToWorkflow/rowToNode path, so a single malformed workflow head must not abort the sweep
    // (which would leave every later entry on the old basis → spurious gate re-eval at cutover).
    try {
      const run = deps.runRepo.getRun(entry.runId);
      if (!run?.definitionVersion) continue; // unpinned → no version-stable basis yet

      // Validity guard (see module doc): reproduce the EXACT pre-cutover fingerprint — the
      // sanitized HEAD gate (legacyGateMetadata present, as markDeprecatedGate adds) hashed with
      // legacyGateDefinitionHash (the order-sensitive bare hash the pre-cutover
      // generateGateFingerprint used to compute stored values). Use the manager's HEAD read
      // (getWorkflow), NOT the pinned resolution (getWorkflowForRun), which post-cutover returns
      // the pinned version. Skip entries that don't match (stale) so they re-evaluate rather
      // than get promoted.
      const sanitizedHead = deps.manager.getWorkflow(run.workflowId);
      if (!sanitizedHead) continue; // deleted-head orphan → no provenance → leave stale
      const sanitized = deps.manager.getWorkflowForRun(run);
      if (!sanitized) continue;

      // Guard 1: stored fingerprint matches the head's pre-cutover fingerprint.
      const headGate = (sanitizedHead.gates ?? []).find((g) => g.id === entry.gateId);
      const headOldFingerprint = headGate
        ? sanitizedHead.updatedAt + legacyGateDefinitionHash(headGate)
        : sanitizedHead.updatedAt;
      if (entry.workflowUpdatedAt !== headOldFingerprint) continue; // stale → re-evaluate

      // Guard 2: the head and pinned gates must match — if the head was edited after the run
      // was pinned, the cache may have been opened under a more permissive gate than the
      // (stricter) pinned one; re-keying it would bypass evaluation.
      const pinnedGateForCheck = (sanitized.gates ?? []).find((g) => g.id === entry.gateId);
      if (stableStringify(headGate) !== stableStringify(pinnedGateForCheck)) {
        continue; // head ≠ pinned → re-evaluate against the pinned definition
      }

      const gateDef = (sanitized.gates ?? []).find((g) => g.id === entry.gateId);
      const expected = gateDef
        ? pinnedGateFingerprint(run.definitionVersion, gateDef)
        : stableVersionTimestamp(run.definitionVersion);
      if (entry.workflowUpdatedAt !== expected) {
        deps.gateOpenStateRepo.markOpened(entry.runId, entry.gateId, expected);
      }
    } catch (err) {
      log.warn(
        `rekeyPinnedGateOpenCaches: skipped gate-open entry ${entry.runId}/${entry.gateId} (non-fatal):`,
        err
      );
    }
  }
}
