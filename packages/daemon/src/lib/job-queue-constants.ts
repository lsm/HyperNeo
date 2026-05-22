/**
 * Job queue name constants.
 * Use these constants when enqueueing or registering handlers to avoid typos.
 */

export const SESSION_TITLE_GENERATION = 'session.title_generation';
export const GITHUB_POLL = 'github.poll';
export const ROOM_TICK = 'room.tick';
export const JOB_QUEUE_CLEANUP = 'job_queue.cleanup';
export const SKILL_VALIDATE = 'skill.validate';
export const MEMORY_CONSOLIDATION = 'memory_consolidation';
export const SPACE_CONVERSATION_FRICTION_ANALYZE = 'space.conversationFriction.analyze';

// ─── Task schedule ────────────────────────────────────────────────────────────
export const TASK_SCHEDULE_FIRE = 'taskSchedule.fire';

// ─── Space workflow run artifact sync queues ──────────────────────────────────
// Background jobs that populate the workflow_run_artifact_cache table with
// git-derived data (gate artifacts, commit log, per-file diffs). Running these
// in the job queue keeps the TaskArtifactsPanel RPC handlers fast; the handler
// emits a `space.artifactCache.updated` InternalEventBus<DaemonInternalEventMap> event when a row is
// refreshed so the frontend can refetch without polling.
export const SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS = 'spaceWorkflowRun.syncGateArtifacts';
export const SPACE_WORKFLOW_RUN_SYNC_COMMITS = 'spaceWorkflowRun.syncCommits';
export const SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF = 'spaceWorkflowRun.syncFileDiff';
