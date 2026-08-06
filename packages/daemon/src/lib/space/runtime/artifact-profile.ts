/**
 * Workflow Artifact Profile — the domain seam between generic workflow infra
 * (daemon core) and a domain layer.
 *
 * Infra knows the closed SHAPE vocabulary (`link`, `commit_set`, `check`,
 * `metric`, `decision`, `note`) but never a domain KIND (`pr`, `review`, …).
 * Anything that depends on what a particular kind means — which `link` is the
 * run's primary URL, which `decision` is the terminal outcome, what to persist
 * when a particular gate fires — lives behind this interface. The coding-
 * workflow layer supplies the implementation; infra only calls the methods.
 *
 * All methods are best-effort: implementations log and return a safe default
 * ('' / null / no-op) on error rather than throwing, so a profile failure can
 * never break infra control flow.
 */

/**
 * Event passed to {@link WorkflowArtifactProfile.onGateDataCommitted} after a
 * gated `send_message` commits a gate-data write (before message delivery).
 */
export interface GateDataCommittedEvent {
  runId: string;
  nodeId: string;
  gateId: string;
  /** The committed gate data (after the field merge). */
  gateData: Record<string, unknown>;
  /**
   * The gate-declared fields the sender was authorized to write in this
   * `send_message` (the subset of `data` that actually committed to gate_data).
   * Domain hooks key side-artifacts off these, not the raw payload, so a field
   * the agent sent but was not authorized to write cannot trigger a side-effect.
   */
  committedData?: Record<string, unknown>;
  /** The raw `data` payload from the originating `send_message` call. */
  messageData?: Record<string, unknown>;
}

export interface WorkflowArtifactProfile {
  /**
   * Resolve the canonical "primary link" URL for a run — the single URL infra
   * treats as THE link: gate-script `prUrl`, merge-template `{{pr_url}}`, and PR
   * event subscriptions all read this. The coding profile knows it is the PR
   * (`link kind:'pr'`); generic infra does not. Returns '' when none.
   */
  resolvePrimaryLinkUrl(runId: string): string;

  /**
   * Build a short terminal outcome summary from a run's artifacts, or null when
   * the run recorded no outcome. Used by task completion (mark_complete / run
   * completion / Forge gap detection). The coding profile reads the kindless
   * terminal `decision`.
   */
  summarizeRunOutcome(runId: string): string | null;

  /**
   * Hook fired after a gated `send_message` commits gate data, before delivery.
   * Lets a domain layer persist side-artifacts keyed to that gate. The coding
   * profile records a `decision kind:'review'` (round-N) each time the
   * review-posted-gate receives a `review_url`. Fire-and-forget from infra's
   * perspective: errors are logged by the caller, never propagated.
   */
  onGateDataCommitted?(event: GateDataCommittedEvent): Promise<void> | void;
}
