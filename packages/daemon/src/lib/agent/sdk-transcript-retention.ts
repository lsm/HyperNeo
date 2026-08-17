import type { Settings } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK transcript retention (days) for every SDK subprocess the daemon spawns.
 *
 * The SDK/Claude CLI deletes chat transcripts idle longer than
 * `cleanupPeriodDays` (default 30) on startup, scanning ALL of
 * `~/.claude/projects` — including transcripts of long-idle HyperNeo sessions
 * the daemon DB still considers active and resumable. A purged transcript
 * wedges the session's delivery queue on `sdk_resume_choice` forever (the
 * resume can never succeed and nothing dead-letters it). Retention is
 * therefore owned solely by HyperNeo: session archive moves transcripts to
 * `~/.hyperneo/claude-session-archives/`; live sessions' transcripts must never
 * be swept by a subprocess. The SDK documents a large value as the way to
 * opt out of cleanup (min 1; `persistSession: false` would break resume).
 */
export const SDK_TRANSCRIPT_RETENTION_DAYS = 3650;

/**
 * Merge the daemon's transcript-retention policy into SDK settings for a
 * launch. `QueryOptionsBuilder.build()` applies this centrally; every direct
 * `query()` call that bypasses the builder (title generation, workflow
 * selection, model discovery, GitHub router/security agents, evolution
 * services) MUST pass `settings: withSdkTranscriptRetention(...)` too — the
 * CLI cleanup runs at subprocess startup and scans ALL of ~/.claude/projects,
 * so a single unprotected routine launch can still purge a long-idle
 * session's transcript before its next main query.
 */
export function withSdkTranscriptRetention(settings?: Settings): Settings {
  return { ...settings, cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS };
}
