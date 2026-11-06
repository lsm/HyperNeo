# ADR 0010: Opt-in native Codex through OAP

Status: proposed (2026-11-04 re-read)

## Context

The existing `QueryLike` seam can preserve HyperNeo's message and turn handling while an OAP hub drives a native harness. The re-read was static; no oapx, real Codex or tests were run.

## Decision

Plan an opt-in Codex native app-server path through `oapx serve --stdio`, leaving the SDK as the default. Reuse `QueryLike` and SDK-shaped messages. Map the HyperNeo session ID to OAP and the Codex thread ID to `sdk_session_id`; persist hub bindings with `--session-history` and reopen when supported. Only explicit unsupported or unknown-session responses permit summary fallback, with a visible notice.

## Consequences

Daemon engine code owns the integration; Neo core remains unaware of OAP and its driver passes harness provenance. Initial Codex sessions exclude work needing daemon tools, session instructions or tool guards. Real restart, permission and tool journeys remain necessary before those capabilities can be claimed. Release pin, client tools, instruction mapping and permission posture remain human decisions.
