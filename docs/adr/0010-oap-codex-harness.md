# ADR 0010: Opt-in native Codex through OAP

Status: accepted 2026-11-07 (scope confirmed in card 15606da2)

## Context

The existing `QueryLike` seam can preserve HyperNeo's message and turn handling while an OAP hub drives a native harness. The re-read was static; no oapx, real Codex or tests were run.

## Decision

Use an opt-in Codex native app-server path through `oapx serve --stdio`, leaving the SDK as the default. Reuse `QueryLike` and SDK-shaped messages. Map the HyperNeo session ID to OAP and the Codex thread ID to `sdk_session_id`; persist hub bindings with `--session-history` and reopen when supported. The proposed summary fallback permits only an unknown session or a refusal specifically of reopen, with a visible notice; it is not yet wired.

## Consequences

The engine, transport, workspace wiring, attempt-bound turns and initial reopen slice have shipped. Synthetic-peer proofs cover restart; live Codex acceptance and native reopen remain unverified. Named stdio opens can elect an absolute existing directory on an OAP `any_directory` adapter ([OAP #1684](https://github.com/lsm/open-agent-protocol/pull/1684)). Daemon engine code owns the integration; Neo core remains unaware of OAP and its driver passes harness provenance. Initial Codex sessions exclude work needing daemon tools, session instructions or tool guards. Real restart, permission and tool journeys remain necessary before those capabilities can be claimed. Release pin, client tools, instruction mapping and permission posture remain human decisions.
