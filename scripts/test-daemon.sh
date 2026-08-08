#!/bin/bash
# test-daemon.sh — Run daemon unit tests with parallel shards and failure summary.
#
# Requires: node + vitest (per-package devDependencies), python3 (for --show-failures)
#
# Usage:
#   ./scripts/test-daemon.sh                # All shards in parallel (fast, no coverage)
#   ./scripts/test-daemon.sh --coverage     # All shards with coverage
#   ./scripts/test-daemon.sh 5-space-runtime-a # Run a single shard
#   ./scripts/test-daemon.sh --rerun        # Rerun only previously failing files
#   ./scripts/test-daemon.sh --show-failures # Show failure details from last run

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

export HYPERNEO_ALLOW_ROOT_TEST=1

SHARDS=(
	shared
	0-shared-handlers-workflow
	1-core
	4-space-storage
	4-space-migrations-a
	4-space-migrations-b
	5-space-agent-other
	5-space-runtime-a
	5-space-runtime-b
)
RESULTS_DIR="$REPO_ROOT/test-results/daemon"
FAILURES_FILE="$RESULTS_DIR/failures.txt"
PRELOAD="$REPO_ROOT/packages/daemon/tests/unit/setup.ts"
TEST_ROOT="$REPO_ROOT/packages/daemon/tests/unit"

# Split storage migration tests dynamically so new files are picked up without
# editing this script. Bash glob order is deterministic.
migration_shard_paths() {
	local parity="$1"
	local files=(
		"$TEST_ROOT/4-space-storage/storage"/migration*.test.ts
		"$TEST_ROOT/4-space-storage/storage/migrations"/*.test.ts
		"$TEST_ROOT/4-space-storage/storage/migrations"/*_test.ts
	)
	local index=0
	local file

	for file in "${files[@]}"; do
		[ -e "$file" ] || continue
		if [ $((index % 2)) -eq "$parity" ]; then
			printf '%s\n' "$file"
		fi
		index=$((index + 1))
	done
}

# Map shard name to one or more test paths. Shards are balanced by CI wall time.
shard_paths() {
	case "$1" in
	0-shared-handlers-workflow)
		# Under Vitest each test file is module-isolated, so the old "shared first"
		# ordering (to avoid bun mock.module leakage) no longer applies. Shared runs
		# as its own shard below with its own vitest config.
		printf '%s\n' \
			"$TEST_ROOT/2-handlers" \
			"$TEST_ROOT/5-space/workflow"
		;;
	shared)
		printf '%s\n' "$REPO_ROOT/packages/shared/tests"
		;;
	1-core)
		printf '%s\n' "$TEST_ROOT/1-core"
		;;
	4-space-storage)
		printf '%s\n' "$TEST_ROOT/4-space-storage"/*.test.ts "$TEST_ROOT/4-space-storage/app"
		for file in "$TEST_ROOT/4-space-storage/storage"/*.test.ts; do
			case "$(basename "$file")" in
			migration-*) ;;
			*) printf '%s\n' "$file" ;;
			esac
		done
		;;
	4-space-migrations-a)
		migration_shard_paths 0
		;;
	4-space-migrations-b)
		migration_shard_paths 1
		;;
	5-space-agent-other)
		printf '%s\n' "$TEST_ROOT/5-space"/*.test.ts "$TEST_ROOT/5-space/agent" "$TEST_ROOT/5-space/other"
		;;
	5-space-runtime-a)
		printf '%s\n' \
			"$TEST_ROOT/5-space/runtime/prompt-too-long-recovery.test.ts" \
			"$TEST_ROOT/5-space/runtime/prompt-too-long-replay.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-worktree-manager.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-tick-loop.test.ts" \
			"$TEST_ROOT/5-space/runtime/task-dependency-enforcement.test.ts" \
			"$TEST_ROOT/5-space/runtime/last-message-classifier.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-stalled-recovery.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-edge-cases.test.ts" \
			"$TEST_ROOT/5-space/runtime/task-draft-status.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-agent-task-creation-flow.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-agent-autonomy.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-llm-workflow-selection.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-disabled-workflow.test.ts" \
			"$TEST_ROOT/5-space/runtime/reply-routing-registry.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-orphan-question.test.ts"
		;;
	5-space-runtime-b)
		printf '%s\n' \
			"$TEST_ROOT/5-space/runtime/space-agent-tools.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-external-events.test.ts" \
			"$TEST_ROOT/5-space/runtime/github-subscription-pattern.test.ts" \
			"$TEST_ROOT/5-space/runtime/long-horizon-subscription-pattern.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-event-driven-gate-evaluation.test.ts" \
			"$TEST_ROOT/5-space/runtime/external-event-delivery-e2e.test.ts" \
			"$TEST_ROOT/5-space/runtime/parse-pr-url.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-workflow.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-notifications.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-completion.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-rehydration.test.ts" \
			"$TEST_ROOT/5-space/runtime/post-approval-router.test.ts" \
			"$TEST_ROOT/5-space/runtime/post-approval-routing-integration.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-dispatch-post-approval.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-runtime-service.test.ts" \
			"$TEST_ROOT/5-space/runtime/task-status-transitions.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-slug.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-chat-agent.test.ts" \
			"$TEST_ROOT/5-space/runtime/space-mcp-session-policy.test.ts" \
			"$TEST_ROOT/5-space/runtime/topic-trie.test.ts" \
			"$TEST_ROOT/5-space/runtime/connectors"
		;;
	*)
		return 1
		;;
	esac
}

# Parse arguments
COVERAGE=false
RERUN=false
SHOW_FAILURES=false
TARGET_SHARD=""

for arg in "$@"; do
	case "$arg" in
	--coverage)       COVERAGE=true ;;
	--rerun)          RERUN=true ;;
	--show-failures)  SHOW_FAILURES=true ;;
	*)                TARGET_SHARD="$arg" ;;
	esac
done

mkdir -p "$RESULTS_DIR"

# --- Show failures from last run ---
if [ "$SHOW_FAILURES" = true ]; then
	shard_count=0
	for shard in "${SHARDS[@]}"; do
		junit="$RESULTS_DIR/junit-${shard}.xml"
		[ -f "$junit" ] || continue

		fail_count=$(grep '<testsuites' "$junit" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
		[ "${fail_count:-0}" -eq 0 ] && continue

		shard_count=$((shard_count + 1))
		echo "--- $shard ---"

		python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$junit')
for tc in tree.iter('testcase'):
    if tc.find('failure') is not None:
        # classname is the file path in vitest junit (there is no `file=`/
        # `line=`); printing both as "?" made --show-failures useless.
        print(f\"{tc.get('classname', '?')}\")
        print(f\"  {tc.get('name', '?')}\")
" 2>/dev/null
		echo ""
	done

	if [ "$shard_count" -eq 0 ]; then
		echo "No failures found in last run (or no junit files exist)."
		echo "Run ./scripts/test-daemon.sh first."
	else
		echo ""
		echo "To rerun failing tests:"
		echo "  ./scripts/test-daemon.sh --rerun"
	fi
	exit 0
fi

# --- Rerun mode ---
if [ "$RERUN" = true ]; then
	if [ ! -f "$FAILURES_FILE" ] || [ ! -s "$FAILURES_FILE" ]; then
		echo "No previous failures found. Run full tests first."
		exit 0
	fi
	FAILING_FILES=$(cat "$FAILURES_FILE")
	FILE_COUNT=$(echo "$FAILING_FILES" | wc -l | tr -d ' ')
	echo "Rerunning $FILE_COUNT failing test file(s)..."
	# shellcheck disable=SC2086
	(cd "$REPO_ROOT/packages/daemon" && NODE_ENV=test node_modules/.bin/vitest run $FAILING_FILES)
	exit $?
fi

# --- Determine shards to run ---
if [ -n "$TARGET_SHARD" ]; then
	RUN_SHARDS=("$TARGET_SHARD")
else
	RUN_SHARDS=("${SHARDS[@]}")
fi

# Build coverage flags (Vitest v8 coverage)
COV_FLAGS=""
if [ "$COVERAGE" = true ]; then
	COV_FLAGS="--coverage --coverage.reporter=text --coverage.reporter=lcov --coverage.reportsDirectory=coverage"
fi

# --- Run shards in parallel ---
PIDS=()

WALL_START=$(date +%s)

echo "Running daemon unit tests (${#RUN_SHARDS[@]} shard(s))..."
echo ""

# Run one shard under Vitest. Routes to the owning package's vitest config:
# `shared` runs from packages/shared; everything else runs from packages/daemon.
# Emits junit XML to $JUNIT_FILE and full output to $LOG_FILE.
run_shard() {
	local shard="$1"
	local junit_file="$2"
	local log_file="$3"
	shift 3
	local pkg_dir
	if [ "$shard" = "shared" ]; then
		pkg_dir="$REPO_ROOT/packages/shared"
	else
		pkg_dir="$REPO_ROOT/packages/daemon"
	fi

	# shellcheck disable=SC2086
	(
		cd "$pkg_dir" || exit 1
		NODE_ENV=test node_modules/.bin/vitest run \
			--reporter=dot \
			--reporter=junit \
			--outputFile.junit="$junit_file" \
			$COV_FLAGS \
			"$@"
	) >"$log_file" 2>&1
}

for shard in "${RUN_SHARDS[@]}"; do
	JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
	LOG_FILE="$RESULTS_DIR/output-${shard}.log"
	rm -f "$JUNIT_FILE" "$LOG_FILE"
	TEST_PATHS=($(shard_paths "$shard"))
	if [ "${#TEST_PATHS[@]}" -eq 0 ]; then
		echo "Unknown daemon test shard: $shard" >&2
		exit 1
	fi

	# Migration tests rebuild full old schemas and re-run the entire migration
	# suite for idempotency checks — legitimately heavy work that flakes at
	# vitest's 5s default under parallel shard load (migration-45/53 timeouts
	# blocked this PR across rounds 11/19/21). Give the migration shards a
	# generous per-test timeout; other shards keep the default.
	case "$shard" in
		4-space-migrations-*) EXTRA_FLAGS="--test-timeout=30000" ;;
		*) EXTRA_FLAGS="" ;;
	esac

	# shellcheck disable=SC2086
	run_shard "$shard" "$JUNIT_FILE" "$LOG_FILE" $EXTRA_FLAGS "${TEST_PATHS[@]}" &

	PIDS+=($!)
done

# Wait for all shards
for pid in "${PIDS[@]}"; do
	wait "$pid" 2>/dev/null || true
done

# --- Parse results from junit XML ---
TOTAL_TESTS=0
TOTAL_FAILS=0
TOTAL_SKIPS=0
TOTAL_TIME_MS=0
HAD_FAILURE=0

: > "$FAILURES_FILE"

printf "%-22s %8s %8s %8s %8s\n" "Shard" "Tests" "Pass" "Fail" "Time"
printf "%-22s %8s %8s %8s %8s\n" "----------------------" "--------" "--------" "--------" "--------"

for shard in "${RUN_SHARDS[@]}"; do
	JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
	LOG_FILE="$RESULTS_DIR/output-${shard}.log"

	if [ ! -f "$JUNIT_FILE" ]; then
		printf "%-22s %8s %8s %8s %8s\n" "$shard" "ERROR" "-" "-" "-"
		HAD_FAILURE=1
		if [ -f "$LOG_FILE" ]; then
			echo "  Last output from $shard:"
			tail -5 "$LOG_FILE" | sed 's/^/    /'
		fi
		continue
	fi

	# Extract counts from the root <testsuites> element
	root_attrs=$(grep '<testsuites' "$JUNIT_FILE")
	tests=$(echo "$root_attrs" | grep -o 'tests="[0-9]*"' | grep -o '[0-9]*')
	failures=$(echo "$root_attrs" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
	skipped=$(echo "$root_attrs" | grep -o 'skipped="[0-9]*"' | grep -o '[0-9]*')
	time_s=$(echo "$root_attrs" | grep -o 'time="[0-9.]*"' | sed 's/time="//;s/"//')
	time_ms=$(awk "BEGIN {printf \"%.0f\", ${time_s:-0} * 1000}")

	tests=${tests:-0}
	failures=${failures:-0}
	skipped=${skipped:-0}
	time_ms=${time_ms:-0}
	passed=$((tests - failures - skipped))

	TOTAL_TESTS=$((TOTAL_TESTS + tests))
	TOTAL_FAILS=$((TOTAL_FAILS + failures))
	TOTAL_SKIPS=$((TOTAL_SKIPS + skipped))
	TOTAL_TIME_MS=$((TOTAL_TIME_MS + time_ms))

	fmt_time=$(awk "BEGIN {printf \"%.1f\", $time_ms / 1000}")

	printf "%-22s %8s %8s %8s %7ss\n" "$shard" "$tests" "$passed" "$failures" "$fmt_time"

	if [ "$failures" -gt 0 ]; then
		HAD_FAILURE=1
		# Collect failing test files for `--rerun`. Vitest's junit <testcase>
		# carries the file path in `classname` (there is no `file=` attribute),
		# so grepping `file="..."` always comes up empty and `--rerun` reported
		# "No previous failures". Pull classname from failing cases instead.
		python3 - "$JUNIT_FILE" "$FAILURES_FILE" <<'PYEOF'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
fails = sorted({tc.get('classname') for tc in root.iter('testcase')
                if tc.find('failure') is not None and tc.get('classname')})
if fails:
    with open(sys.argv[2], 'a') as f:
        f.write('\n'.join(fails) + '\n')
PYEOF
		# Surface each failing test + its assertion message from the junit XML so
		# the detail is visible in the CI console (vitest output is otherwise only
		# in a per-shard log file that isn't uploaded as an artifact).
		echo ""
		echo "============================== failures: $shard =============================="
		python3 - "$JUNIT_FILE" <<'PYEOF'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
for tc in root.iter('testcase'):
    fail = tc.find('failure')
    if fail is None:
        continue
    name = tc.get('name', '?')
    cls = tc.get('classname', '?')
    msg = (fail.get('message') or fail.text or '').strip()
    print(f"FAIL {cls} > {name}")
    if msg:
        for line in msg.splitlines()[:15]:
            print(f"     {line}")
        print()
PYEOF
		echo "=============================================================================="
	fi
done

fmt_total=$(awk "BEGIN {printf \"%.1f\", $TOTAL_TIME_MS / 1000}")

printf "%-22s %8s %8s %8s %8s\n" "----------------------" "--------" "--------" "--------" "--------"
printf "%-22s %8s %8s %8s %7ss\n" "TOTAL" "$TOTAL_TESTS" "$((TOTAL_TESTS - TOTAL_FAILS - TOTAL_SKIPS))" "$TOTAL_FAILS" "$fmt_total"

WALL_END=$(date +%s)
WALL_SECS=$((WALL_END - WALL_START))

if [ "$HAD_FAILURE" -eq 1 ]; then
	echo ""
	FAIL_COUNT=$(sort -u "$FAILURES_FILE" | wc -l | tr -d ' ')
	echo "FAILURES ($FAIL_COUNT file(s)):"
	sort -u "$FAILURES_FILE" | while IFS= read -r file; do
		echo "  $file"
	done
	echo ""
	# Dump per-shard log output on failure so CI runners can diagnose the issue
	# without having to download junit artifacts. Only dump shards that failed.
	if [ -n "${CI:-}" ] || [ "${TEST_DAEMON_DUMP_ON_FAIL:-}" = "1" ]; then
		for shard in "${RUN_SHARDS[@]}"; do
			JUNIT_FILE="$RESULTS_DIR/junit-${shard}.xml"
			LOG_FILE="$RESULTS_DIR/output-${shard}.log"
			[ -f "$JUNIT_FILE" ] || continue
			shard_fails=$(grep '<testsuites' "$JUNIT_FILE" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
			if [ "${shard_fails:-0}" -gt 0 ] && [ -f "$LOG_FILE" ]; then
				echo "========================================================================"
				echo "Shard output: $shard"
				echo "========================================================================"
				cat "$LOG_FILE"
				echo "========================================================================"
				echo ""
			fi
		done
	fi
	echo "To rerun failing tests:"
	echo "  ./scripts/test-daemon.sh --rerun"
else
	echo ""
	echo "All tests passed!"
fi

echo "Wall time: ${WALL_SECS}s"

exit "$HAD_FAILURE"
