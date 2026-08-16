/**
 * Workflow Artifact Profile — the domain seam between generic workflow infra
 * (daemon core) and a domain layer.
 *
 * Infra knows the closed SHAPE vocabulary (`link`, `commit_set`, `check`,
 * `metric`, `decision`, `note`) but never a domain KIND (`pr`, `review`, …).
 * Anything that depends on what a particular kind means — which `link` is the
 * run's primary URL, which `decision` is the terminal outcome — lives behind
 * this interface. The coding-workflow layer supplies the implementation; infra
 * only calls the methods.
 *
 * All methods are best-effort: implementations log and return a safe default
 * ('' / null / no-op) on error rather than throwing, so a profile failure can
 * never break infra control flow.
 */

export interface WorkflowArtifactProfile {
  /**
   * Resolve the canonical "primary link" URL for a run — the single URL infra
   * treats as THE link: merge-template `{{pr_url}}` and PR event subscriptions
   * all read this. The coding profile knows it is the PR (`link kind:'pr'`);
   * generic infra does not. Returns '' when none.
   */
  resolvePrimaryLinkUrl(runId: string): string;

  /**
   * Resolve the first primary link identity established for a run. Completion
   * safety checks use this immutable identity so a later artifact cannot swap
   * the reviewed PR for a different already-merged PR.
   */
  resolveInitialPrimaryLinkUrl?(runId: string): string;

  /**
   * Whether an artifact write could change the run's primary link — used by the
   * generic save_artifact layer to decide whether to fire the record-triggered
   * topicFrom materialization. Owns the domain's link-bearing data keys (the
   * coding profile's legacy `prUrl`/`pr_url`); the closed `shape === 'link'`
   * vocabulary check stays in the caller. `previousData` is the row this upsert
   * replaces (null when none): a re-upsert that DROPS a previously carried link
   * field is still link-bearing (it clears the durable link).
   */
  isLinkBearing?(
    shape: string,
    data: Record<string, unknown>,
    previousData: Record<string, unknown> | null
  ): boolean;

  /**
   * Build a short terminal outcome summary from a run's artifacts, or null when
   * the run recorded no outcome. Used by task completion (mark_complete / run
   * completion / Forge gap detection). The coding profile reads the kindless
   * terminal `decision`.
   */
  summarizeRunOutcome(runId: string): string | null;
}
