/**
 * Production built-in validator registration — epic #2299 (P2 #2302).
 *
 * The single place that binds concrete named presets to the engine. Each
 * registered id is a "named preset" (ADR #2): the engine (`hook-executor.ts`)
 * dispatches it generically via the registry, and `workflow-hook-validation.ts`
 * admits it generically via the registry — no id is special-cased in either.
 *
 * Registered presets:
 *   - `pr_ready`  — coder→reviewer handoff gate. Deployed on the production
 *     `createPrReadyValidator()` impl (PR-view + review-threads + discovery +
 *     patch_params) so the one deployed github path is byte-identical. Its
 *     L3-over-L2 expression (`createPrReadyValidatorV2`, see
 *     `connectors/presets.ts`) is the proven target form; the cutover is a
 *     follow-up once reason-string + discovery parity is exhaustively ported.
 *   - `pr_merged` — mark_complete merge gate. Net-new capability, expressed
 *     directly as an `external_state` preset over the github connector's
 *     `getPr` op (state == MERGED). No legacy execution path to preserve.
 *
 * Imported for its side effect by `workflow-hook-validation.ts` so the registry
 * is populated before any validation runs (and transitively by the hook
 * executor, which imports validation). Safe to call repeatedly (registration
 * overwrites).
 */

import { registerBuiltInValidator } from '../built-in-validator-registry';
import { createPrReadyValidator } from './pr-ready-validator';
import { createPrMergedValidator } from '../connectors/presets';

/** Seed the built-in validator registry for production. Idempotent. */
export function registerProductionBuiltInValidators(): void {
  registerBuiltInValidator('pr_ready', createPrReadyValidator());
  registerBuiltInValidator('pr_merged', createPrMergedValidator());
}

registerProductionBuiltInValidators();
