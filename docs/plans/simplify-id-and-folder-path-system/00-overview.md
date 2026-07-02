# Simplify ID and Folder Path System — Overview

## Goal

Replace opaque full UUIDs in user-facing surfaces (URLs, logs, CLI, UI) with short, human-readable IDs scoped to their parent context, while preserving full backward compatibility and zero-migration policy for existing data.

## Problem Statement

HyperNeo currently uses full UUIDs everywhere:
- Task IDs: `d8a578c6-d3cb-4c84-926b-958cbd433d32`
- Room session IDs: `room:chat:04062505-780f-4881-a3be-9cb9062790fb`
- Worktree paths: `~/.hyperneo/projects/-Users-lsm-focus-dev-neokai/worktrees/planner-04062505-780f-4881-a3be-9cb9062790fb-144eca1d-06fc-49e1-92f3-afa246aecc4d-2bb0b719`
- Worker session IDs: `coder:04062505-780f-4881-a3be-9cb9062790fb:d8a578c6-d3cb-4c84-926b-958cbd433d32:abc12345`

These make logs unreadable, URLs unmemorable, and directory paths excessively long.

## Approach

**Scoped counter-based short IDs** — each entity type gets a monotonically increasing integer counter scoped to its parent context (room). The full UUID remains the primary key; the short ID is a derived, secondary address.

Format:
- Tasks: `t-42` (sequential integer per room, formatted with prefix)
- Goals: `g-7` (sequential integer per room)
- Sessions: **out of scope for this goal** — session IDs involve complex worker/leader lifecycle coupling; session short IDs are a separate future effort

Worktree path shortening: use the first 8 characters of the room UUID as a project directory name instead of the full encoded repo path.

**Key design constraints:**
1. Zero DB migration — add nullable `short_id` columns; compute on first access for old records
2. Backward compatibility — all APIs accept both UUID and short ID as input
3. Both IDs always returned in API responses (`id` + `shortId`)
4. Multi-tenant safe — counters are scoped to room, preventing cross-tenant collisions
5. URL routing updated to accept both formats

## Milestones

1. **Short ID Infrastructure** — Add `short_id` columns, counter tables, and `generateShortId()` utility in shared package
2. **Repository Layer** — Add short ID assignment on create and lookup-by-short-id to Task, Goal, and Room repositories
3. **API Compatibility Layer** — Update all RPC handlers to return `shortId` and accept both UUID and short ID as input; update URL route regexes in the web router
4. **Worktree Path Shortening** — Shorten worktree base directory using a project short key derived from the repo path
5. **UI Display** — Display short IDs in task/goal cards and copy-to-clipboard helpers in the web frontend
6. **Tests and Validation** — Unit tests for short ID utilities, repository layer, API compatibility, and multi-tenant isolation

## Cross-Milestone Dependencies

- Milestones 2, 3, 4 all depend on Milestone 1 (infrastructure must exist first)
- Milestone 5 depends on Milestone 3 (API must return `shortId` before UI can display it)
- Milestone 6 should be written alongside each coding milestone but can be consolidated into a final validation pass
- Milestone 4 (path shortening) is independent of Milestones 2–3 and can run in parallel with them

## Estimated Task Count

~18 tasks across 6 milestones
