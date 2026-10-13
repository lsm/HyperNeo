#!/usr/bin/env bash
# Guard: Task #85 invariant.
#
# Only the UI RPC paths may call:
#   - SessionManager.deleteSessionResources / SessionLifecycle.deleteResources
#   - SessionManager.archiveSessionResources / SessionLifecycle.archiveResources
#   - SessionRepository.deleteSession / Database.deleteSession (raw DB deletes
#     that bypass the lifecycle primitive entirely)
# plus the `ui_session_delete` / `ui_room_delete` / `ui_session_archive` /
# `ui_task_archive` trigger identifiers that document
# the caller.
#
# Any other file reaching for these names is almost certainly reintroducing
# the data-loss path that #1566 / #1572 / Task #85 closed. When a new
# legitimate caller is added (e.g. another UI action), explicitly add it to
# the allowlist below.
#
# Exits with non-zero status when an unexpected caller is found.

set -euo pipefail

cd "$(dirname "$0")/.."

# Allow-listed files (relative to repo root). Extend with care.
ALLOWLIST=(
    # The primitives themselves
    "packages/daemon/src/lib/session/session-lifecycle.ts"
    "packages/daemon/src/lib/session/session-manager.ts"

    # The raw DB primitives (they implement the delete — must own the symbol).
    "packages/daemon/src/storage/repositories/session-repository.ts"
    "packages/daemon/src/storage/index.ts"
    "packages/daemon/src/storage/database.ts"

    # RoomManager — only references trigger names in doc comments that
    # explain the Task #85 contract to future callers. It no longer calls
    # any session-delete primitive itself.
    "packages/daemon/src/lib/room/managers/room-manager.ts"

    # The UI RPC handlers
    "packages/daemon/src/lib/rpc-handlers/session-handlers.ts"
    "packages/daemon/src/lib/rpc-handlers/room-handlers.ts"
    # Human-requested driver archive, gated by a live human turn and idle session.
    "packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts"


    # Task archive pipeline (UI-initiated via task.archive event cascade)
    "packages/daemon/src/lib/space/runtime/task-agent-manager.ts"

    # Guard itself
    "scripts/check-session-deletion-callers.sh"
)

# Pattern: function names + raw DB delete calls + trigger identifiers.
# - `(sessionRepo|sessionRepository)\.deleteSession\b` catches raw
#   SessionRepository.deleteSession callers that bypass the lifecycle.
# - `db\.deleteSession\b` catches Database.deleteSession shims.
# - `\bsessions\.deleteSession\b` catches the db.sessions.deleteSession path.
PATTERN='archiveSessionResources|deleteSessionResources|archiveResources|deleteResources|ui_session_archive|ui_task_archive|ui_session_delete|ui_room_delete|(sessionRepo|sessionRepository)\.deleteSession\b|\bdb\.deleteSession\b|\bsessions\.deleteSession\b'

# grep -r the `packages` tree, excluding tests, docs, and node_modules.
RAW=$(grep -RnE "${PATTERN}" packages \
    --include='*.ts' \
    --include='*.tsx' \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=build \
    --exclude-dir=tests \
    --exclude-dir=__tests__ \
    --exclude='*.test.ts' \
    --exclude='*.spec.ts' \
    2>/dev/null || true)

if [[ -z "${RAW}" ]]; then
    echo "Task #85 guard passed: no references to UI-only session primitives outside of tests."
    exit 0
fi

# Build a regex that matches any allowlisted path as a prefix.
OFFENDERS=""
while IFS= read -r line; do
    file="${line%%:*}"
    allowed=0
    for allowed_path in "${ALLOWLIST[@]}"; do
        if [[ "${file}" == "${allowed_path}" ]]; then
            allowed=1
            break
        fi
    done
    if [[ "${allowed}" -eq 0 ]]; then
        OFFENDERS="${OFFENDERS}${line}"$'\n'
    fi
done <<< "${RAW}"

if [[ -n "${OFFENDERS}" ]]; then
    echo "Task #85 guard FAILED: found non-allowlisted references to UI-only session primitives:" >&2
    echo "" >&2
    printf '%s' "${OFFENDERS}" >&2
    echo "" >&2
    echo "Only UI-initiated RPC handlers may call archiveSessionResources / deleteSessionResources." >&2
    echo "If a new legitimate caller is needed, add its path to ALLOWLIST in" >&2
    echo "scripts/check-session-deletion-callers.sh AND re-run the tests that assert" >&2
    echo "the preserve-DB invariants." >&2
    exit 1
fi

echo "Task #85 guard passed: only allow-listed files call the UI-only session primitives."
