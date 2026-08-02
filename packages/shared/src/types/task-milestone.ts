/**
 * Curated task milestone timeline.
 *
 * The task panel's Timeline section renders a human-meaningful milestone feed
 * (created, status transitions, human instructions, agent answers, PR / review
 * / result artifacts, GitHub CI activity, collapsed API retries) instead of the
 * raw actor-message log. These rows are produced by the `taskMilestones.byTask`
 * LiveQuery, which unions curated, content-rich rows from `space_tasks`,
 * `sdk_messages`, `workflow_run_artifacts`, and `space_github_events`.
 *
 * Unlike the actor-message projection (which emits one generic row per SDK
 * message with labels like "Agent response recorded"), milestone rows carry the
 * REAL content (instruction / answer text, PR number, review verdict) extracted
 * at the source, plus a `tone` drawn from the unified indicator palette so the
 * renderer can colour-code without re-deriving intent.
 */

/**
 * What kind of milestone a row represents. Drives the rendered label and icon.
 */
export type TaskMilestoneCategory =
  | 'creation' // task was created
  | 'status' // lifecycle transition (started / submitted / approved / completed)
  | 'instruction' // a human instruction (real message text)
  | 'answer' // an agent answer (real message text)
  | 'artifact' // a workflow artifact anchor (PR / result / progress)
  | 'review' // a review verdict / approval decision
  | 'github' // GitHub activity (CI result, PR event)
  | 'retry'; // a collapsed API-retry burst

/**
 * Unified indicator tone for the milestone. Matches the keys of the web UI's
 * `INDICATOR_TONES` palette so the renderer can look up dot/badge classes
 * directly.
 */
export type TaskMilestoneTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

/** Origin of the milestone, for optional iconography / source chip. */
export type TaskMilestoneSourceKind = 'human' | 'agent' | 'system' | 'github' | 'review';

/** A single curated milestone row delivered by `taskMilestones.byTask`. */
export interface TaskMilestoneRow {
  /** Stable id (prefixed by source branch, e.g. `answer:`, `artifact:`, `task:started`). */
  id: string;
  /** The task this milestone belongs to. */
  taskId: string;
  /** Milestone kind — drives label and tone. */
  category: TaskMilestoneCategory;
  /** Unified indicator tone for dot/badge colouring. */
  tone: TaskMilestoneTone;
  /** Short human-meaningful headline (e.g. "PR opened", "Approved"). */
  title: string;
  /**
   * Real content extracted at the source — the instruction / answer text, the
   * artifact summary, the CI pass-fail counts, etc. Null when the title alone
   * carries the meaning (e.g. "Task created"). Never a generic placeholder.
   */
  body: string | null;
  /** Who/what produced it (e.g. "Human", "coder", "Review", "GitHub"). */
  sourceLabel: string | null;
  /** Origin kind for the source chip. */
  sourceKind: TaskMilestoneSourceKind | null;
  /**
   * Stable per-session identity for the producer (the SDK session id for
   * instruction / answer / retry rows). Used to scope merge/dedup so that two
   * sessions sharing an agent label aren't folded together. Null when the
   * milestone has no session identity (lifecycle, artifacts, GitHub).
   */
  sourceId: string | null;
  /** When the milestone occurred (milliseconds since epoch). */
  createdAt: number;
}
