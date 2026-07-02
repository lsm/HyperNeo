# Worktree Short Path Design Options

## Problem

Room task worktree paths are excessively long (146 chars to worktree root, up to 235 chars to deep files), risking OS path-length limits and hurting readability.

## Current Path Anatomy

All path lengths in this document are **absolute paths from `/`**, measured with home dir `/Users/lsm` (11 chars including trailing `/`). Actual lengths vary by home directory; the relative savings between options are what matter.

```
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/coder-04062505-780f-4881-a3be-9cb9062790fb-f23fddc6-fec3-4e19-9810-186f9aeebf22-3ca78c48
```

| Segment | Example | Chars | Notes |
|---------|---------|-------|-------|
| Home dir | `/Users/lsm/` | 11 | Fixed, varies per user |
| Base dir | `.hyperneo/projects/` | 18 | Convention |
| Project key | `dev-neokai-ec0a1deb/` | 20 | Short key from PR #792 |
| Worktrees segment | `worktrees/` | 10 | Literal |
| **Session ID leaf** | `coder-04062505-...-3ca78c48` | **88** | **The problem** |
| **Total to root** | | **146** | |
| Deepest file | `packages/daemon/tests/online/.../continuity.test.ts` | **235** | Dangerously close to 260-char Windows limit |

### Root Cause

The session ID format for room tasks is `{role}:{roomId}:{taskId}:{8-char-uuid}`. After colon-to-dash sanitization, this 88-char string becomes the worktree directory name. PR #792's `getProjectShortKey()` shortened the project directory (~8 chars saved) but left the session ID leaf untouched.

### DB Path Inconsistency

`config.ts` still uses the old `encodeRepoPath()` for the database path while `worktree-manager.ts` uses the newer `getProjectShortKey()`. These should be unified.

```
DB (current):   /Users/lsm/.hyperneo/projects/-Users-lsm-focus-dev-neokai/database/daemon.db  (74 chars)
DB (short key): /Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/database/daemon.db           (66 chars)
DB (short+db/): /Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/db/daemon.db                 (60 chars)
```

## What Information Needs to Be in the Path

Currently encoded in the worktree directory name:
- **Role** (`coder`, `leader`) — useful for debugging, not essential
- **Room ID** (UUID) — identifies which room the task belongs to
- **Task ID** (UUID) — identifies the specific task
- **Session UUID suffix** (8 chars) — disambiguates multiple sessions for the same task

Only **uniqueness** is truly required. Debugging context (role, room, task) can be stored in a mapping file or DB lookup.

## Design Constraint: Reverse Lookup

Currently, `worktree-manager.ts` line 271 constructs the worktree path directly from the session ID: `join(worktreesDir, safeSessionId)`. This means `removeWorktree()` and any code that derives a worktree path from a session ID depends on this naming convention.

If the directory name changes to a slug or hash, the worktree path must be **stored in the DB at creation time** and looked up by session ID — not re-derived from the session ID string. The `session_groups` table already stores `workspace_path` (the worktree path), so this lookup path exists. Any implementation must ensure all worktree-path resolution goes through the DB rather than string construction.

## Proposed Options

### Option A: Short Hash Leaf

Replace session-ID leaf with a 12-char hash of the session ID.

```
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/a3b2c1d4f5e6
```

**Absolute path: 63 chars → 83 chars saved vs current 146**

| Pros | Cons |
|------|------|
| Minimal code change (only `createWorktree` + rename `worktrees/` to `wt/`) | Opaque names — can't tell which task a dir belongs to |
| Deterministic (same session → same hash) | Need DB lookup to resolve hash → session |
| No collision risk with 12 hex chars (48 bits) | |

### Option B: Sequential Counter per Project

Monotonically incrementing integer per project, persisted in a counter file.

```
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/42
```

**Absolute path: 53 chars → 93 chars saved vs current 146**

| Pros | Cons |
|------|------|
| Ultra-short, most compact option | Requires persistent counter file |
| Easy to scan (`wt/41/`, `wt/42/`) | Counter drift if file corrupted |
| No collision risk | Sequential numbers leak ordering info |

### Option C: Human-Readable Slug + Short Hash

Derive from branch name (already computed from task title) + 4-char hash suffix.

```
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/fix-login-button-a3b2
```

**Absolute path: 72 chars (typical) → 74 chars saved vs current 146**

**Important**: The existing `slug.ts` caps slugs at `MAX_SLUG_LENGTH = 60` chars (truncated at word boundary). A 60-char slug + `-` + 4-char hash suffix = 65-char leaf, yielding a worst-case absolute path of **116 chars**. To keep paths consistently short, the slug portion should be capped at **25-30 chars** for this use case (separate from the Space slug limit), giving a worst-case of ~86 chars.

| Pros | Cons |
|------|------|
| Human-readable — `ls` output immediately useful | Slightly longer than hash/counter |
| Consistent with Space worktree naming (`worktreeSlug()`) | Need a separate, shorter slug cap for room worktrees |
| Branch name already computed in `task-group-manager.ts:263` | Slug collision handling needed |

### Option D: Flatten Base Directory

Move all worktrees to a shared top-level dir, eliminate per-project nesting.

```
/Users/lsm/.hyperneo/wt/nkai-a3b2c1d4
```

**Absolute path: 35 chars → 111 chars saved vs current 146**

| Pros | Cons |
|------|------|
| Absolute shortest possible | All projects share one flat namespace |
| Minimal nesting depth | Breaks `~/.hyperneo/projects/{key}/` convention |
| | Harder to find worktrees per project |

### Option E: Slug + Hash Leaf ✅ SELECTED

Replace the session-ID leaf with a capped human-readable slug (from the task title) + 4-char hash suffix, keeping the existing `worktrees/` directory name. Also unify DB path to use short key.

```
Worktree: /Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/fix-login-button-a3b2
DB:       /Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/db/daemon.db
```

**Worktree path: 79 chars (typical), 93 chars (worst-case with 30-char slug) → 53-67 chars saved**
**DB path: 60 chars → 14 chars saved vs current 74**

| Pros | Cons |
|------|------|
| Best balance of readability and compactness | Not absolute minimum (79-93 chars) |
| Consistent with Space worktree naming | Need to pass branch/task title into path generation |
| DB path also shortened | Migration needed for existing DB locations |
| Reuses existing `worktreeSlug()` infrastructure | |
| Branch name already available at call site | |
| Keeps familiar `worktrees/` directory name | |

## Concrete Example: Task "Fix login button" in dev-neokai

To make the difference tangible, here is the full absolute path each option would produce for a real task titled **"Fix login button"** in the `dev-neokai` project (room ID `04062505-780f-4881-a3be-9cb9062790fb`, task ID `f23fddc6-fec3-4e19-9810-186f9aeebf22`, session suffix `3ca78c48`):

### Worktree root directory

```
Current (146 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/coder-04062505-780f-4881-a3be-9cb9062790fb-f23fddc6-fec3-4e19-9810-186f9aeebf22-3ca78c48

Option A — Short Hash (63 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/a3b2c1d4f5e6

Option B — Sequential Counter (53 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/42

Option C — Slug + Hash (72 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/fix-login-button-a3b2

Option D — Flat Base (35 chars):
/Users/lsm/.hyperneo/wt/nkai-a3b2c1d4

Option E — Slug + Hash ✅ SELECTED (79 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/fix-login-button-a3b2
```

### Deepest source file (current deepest: 235 chars)

The deepest file in this repo is `packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts` (89 chars of relative path after the worktree root).

```
Current (235 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/coder-04062505-780f-4881-a3be-9cb9062790fb-f23fddc6-fec3-4e19-9810-186f9aeebf22-3ca78c48/packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts

Option A — Short Hash (152 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/a3b2c1d4f5e6/packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts

Option B — Sequential Counter (142 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/42/packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts

Option C — Slug + Hash (161 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/wt/fix-login-button-a3b2/packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts

Option D — Flat Base (124 chars):
/Users/lsm/.hyperneo/wt/nkai-a3b2c1d4/packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts

Option E — Slug + Hash ✅ SELECTED (168 chars):
/Users/lsm/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/fix-login-button-a3b2/packages/daemon/tests/online/cross-provider/conversation-continuity-after-switch.test.ts
```

### What `ls` looks like in the worktrees directory

```bash
# Current — opaque UUID soup, impossible to tell tasks apart:
$ ls ~/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/
coder-04062505-780f-4881-a3be-9cb9062790fb-001fd1e3-2a49-4c22-9f61-74eabce58623-ff2d09f2
coder-04062505-780f-4881-a3be-9cb9062790fb-006b257f-26c7-4861-bcae-85d2182ff317-9f5b5820
coder-04062505-780f-4881-a3be-9cb9062790fb-00cf17b9-b3e6-45d1-8e1a-8e7b18afba0f-38e261f8

# Option E — immediately readable:
$ ls ~/.hyperneo/projects/dev-neokai-ec0a1deb/worktrees/
fix-login-button-a3b2
add-retry-logic-to-ws-7f1e
refactor-session-cleanup-c9d0
update-migration-schema-44ab
```

## Summary Comparison

All path lengths are absolute (from `/`) using `/Users/lsm` as the home directory.

| Option | Absolute Path | Savings vs 146 | Worst Case | Readability | Complexity |
|--------|--------------|-----------------|------------|-------------|------------|
| Current | 146 | — | 146 | Low (UUID soup) | — |
| A: Short Hash | 63 | -83 | 63 | Low | Low |
| B: Sequential | 53 | -93 | ~55 | Medium | Medium |
| C: Slug+Hash | 72 | -74 | 116 (needs cap) | High | Medium |
| D: Flat Base | 35 | -111 | 35 | Low | High |
| **E: Slug+Hash ✅** | **79** | **-67** | **93 (30-char cap)** | **High** | **Medium** |

## Key Files to Modify

| File | What Changes |
|------|-------------|
| `packages/daemon/src/lib/worktree-manager.ts` | `createWorktree()` — use slug instead of session ID for dir name; keep `worktrees/` directory; store path in DB rather than re-deriving from session ID |
| `packages/daemon/src/lib/room/runtime/task-group-manager.ts` | Pass branch name / task title to `createWorktree()` |
| `packages/daemon/src/config.ts` | Switch `encodeRepoPath()` to `getProjectShortKey()` for DB path |
| `packages/daemon/src/lib/space/worktree-slug.ts` | Possibly reuse/share slug logic with room worktrees (with a shorter max-length constant) |

## Migration Strategy

- **New worktrees** get short paths immediately.
- **Existing worktrees** continue working at their old paths until sessions end and they are cleaned up naturally. The `session_groups` table stores absolute worktree paths at creation time, so existing worktrees are looked up by their stored path — not re-derived from the session ID. No path-resolution breakage occurs on daemon restart.
- **DB path migration** requires checking both old (`encodeRepoPath`) and new (`getProjectShortKey`) locations on startup. If the old path exists and the new path doesn't, move (or symlink) the database directory. If both exist, prefer the new path.

## Collision Fallback Note

`worktree-manager.ts` lines 226-233 contain a collision fallback that reverts to the full `encodeRepoPath` when a short-key collision is detected. This fallback produces the old long project path (~27 chars longer). Any implementation of Options A-E should either:
1. Apply the same leaf-shortening strategy regardless of which project key format is used, or
2. Document that the collision fallback is a known edge case where paths remain longer.

In practice, 8-hex-char collisions (32-bit hash space) are rare but possible when managing many repos. The collision fallback is a safety net, not a normal code path.
