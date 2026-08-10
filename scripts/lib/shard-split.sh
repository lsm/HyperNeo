#!/bin/bash
# lib/shard-split.sh — Reusable directory-based test sharding by stable hash.
#
# Why this exists
# ---------------
# When a test directory outgrows a single shard, the usual fix is to split it
# into several shards and *hand-list* which file goes where. Hand-lists rot:
# every new test file must be added by name to the right list, and any file
# someone forgets to list is silently dropped from CI (the daemon unit
# 5-space/runtime split dropped 11 real test files for months before this).
#
# This file provides one reusable mechanism instead:
#
#     "directory = shard, and split an oversized directory into N sub-shards by
#      a stable hash of the file path."
#
# A file's bucket is  stableHash(repoRootRelativePath) % N. Because the hash key
# is the path relative to the repo root, the assignment is identical on every
# developer machine and CI runner regardless of filesystem glob order, and —
# critically — adding or removing a file only ever moves that one file. Every
# existing file keeps its bucket, so re-running is stable and rebalancing is a
# one-number edit (raise N to add a shard, lower it to merge). No file list is
# ever maintained by hand.
#
# Portability
# -----------
# Written for bash 3.2 (macOS default /bin/bash): no associative arrays, no
# globstar. The hash uses POSIX `cksum`, whose CRC algorithm is specified by
# POSIX and identical across BSD (macOS) and GNU (Linux) — so the same path
# hashes to the same integer everywhere.
#
# Dependencies: bash 3.2+, cksum (POSIX), awk, sort, cut, wc.
#
# Usage
# -----
#   source scripts/lib/shard-split.sh
#
#   # Print every file in bucket <bucket_index> (0-based, must be < split_count)
#   # when a directory is split into <split_count> shards. <glob>... are bash
#   # globs relative to any base; list one glob per directory level, e.g.
#   #   dir/*.test.ts dir/sub/*.test.ts
#   shard_split_bucket <repo_root> <split_count> <bucket_index> <glob>...
#
#   # Print the total number of files matched across all globs (for audits and
#   # for choosing <split_count> when rebalancing).
#   shard_split_count <repo_root> <glob>...
#
#   # Print "<bucket>\t<count>" for each bucket — a quick balance check.
#   shard_split_report <repo_root> <split_count> <glob>...
#
# Output of shard_split_bucket is absolute, repo-root-prefixed paths
# (e.g. /path/to/repo/packages/.../foo.test.ts), sorted by hash for stability,
# ready to pass straight to vitest.
#
# Self-test (no args to source; run directly to test the mechanism):
#   bash scripts/lib/shard-split.sh --self-test

# Compute a stable, portable integer hash for a string. POSIX `cksum` prints
# "<crc> <byte-count>"; we keep the crc. Same input → same integer everywhere.
__shard_stable_hash() {
	printf '%s' "$1" | cksum | awk '{print $1}'
}

# Internal: expand every glob, hash each matched file, and emit one line per file:
#   "<10-digit-hash>\t<bucket>\t<repo-root-relative-path>"
# Lines are sorted and de-duplicated. <bucket> is hash % split_count.
__shard_emit() {
	local repo_root="$1" split_count="$2"
	shift 2
	local globs=("$@")
	local glob f rel hash

	for glob in "${globs[@]}"; do
		# Unquoted: let bash expand the glob. The `[ -f ]` guard below skips
		# non-matches (a literal pattern left over when nothing matches) and
		# directories, so no nullglob/shopt is needed — this keeps the helper
		# free of shell-option side effects.
		for f in $glob; do
			[ -f "$f" ] || continue
			# Hash the repo-root-relative path so the key is machine-independent.
			rel="${f#"$repo_root"/}"
			hash=$(__shard_stable_hash "$rel")
			# Zero-pad the hash to 10 digits (cksum crc max is 4294967295) so
			# the upcoming `sort` orders it numerically, not lexically.
			printf '%010d\t%d\t%s\n' "$hash" "$((hash % split_count))" "$rel"
		done
	done
}

shard_split_bucket() {
	local repo_root="$1" split_count="$2" bucket_index="$3"
	shift 3

	# Validate arguments explicitly — this routes CI test files, so a bad value
	# should fail loudly rather than silently run an empty or wrong shard.
	local int_re='^[0-9]+$'
	[[ "$split_count" =~ $int_re ]] || { echo "shard_split_bucket: split_count must be a positive integer, got '$split_count'" >&2; return 2; }
	[[ "$bucket_index" =~ $int_re ]] || { echo "shard_split_bucket: bucket_index must be a non-negative integer, got '$bucket_index'" >&2; return 2; }
	[ "$split_count" -ge 1 ] || { echo "shard_split_bucket: split_count must be >= 1, got '$split_count'" >&2; return 2; }
	[ "$bucket_index" -lt "$split_count" ] || { echo "shard_split_bucket: bucket_index $bucket_index out of range [0,$((split_count - 1))] for split_count $split_count" >&2; return 2; }
	[ "$#" -ge 1 ] || { echo "shard_split_bucket: at least one glob is required" >&2; return 2; }

	# sort -u dedupes files matched by overlapping globs and orders by hash.
	# awk keeps only this bucket and re-prefixes the repo root for absolute paths.
	__shard_emit "$repo_root" "$split_count" "$@" \
		| sort -u \
		| awk -F '\t' -v b="$bucket_index" -v root="$repo_root" '$2 == b { printf "%s/%s\n", root, $3 }'
}

shard_split_count() {
	local repo_root="$1"
	shift
	[ "$#" -ge 1 ] || { echo "shard_split_count: at least one glob is required" >&2; return 2; }
	# split_count=1 puts every file in bucket 0; counting lines = total matched.
	__shard_emit "$repo_root" 1 "$@" | sort -u | wc -l | tr -d ' '
}

shard_split_report() {
	local repo_root="$1" split_count="$2"
	shift 2
	[[ "$split_count" =~ ^[0-9]+$ ]] && [ "$split_count" -ge 1 ] || { echo "shard_split_report: split_count must be a positive integer, got '$split_count'" >&2; return 2; }
	[ "$#" -ge 1 ] || { echo "shard_split_report: at least one glob is required" >&2; return 2; }
	# Bucket column (field 2), tallied per bucket; emit 0 for empty buckets too.
	__shard_emit "$repo_root" "$split_count" "$@" \
		| sort -u \
		| cut -f2 \
		| sort -n \
		| uniq -c \
		| awk -v n="$split_count" 'BEGIN { for (i = 0; i < n; i++) c[i] = 0 } { c[$2] = $1 } END { for (i = 0; i < n; i++) printf "%d\t%d\n", i, c[i] }'
}

# ─── Self-test ──────────────────────────────────────────────────────────────
# Run with: bash scripts/lib/shard-split.sh --self-test
# Exits non-zero on any failure. Uses a temp fixture tree; cleans up on exit.
__shard_self_test() {
	local failures=0
	pass() { printf '  ok   %s\n' "$1"; }
	fail() { printf '  FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

	# assert <pass-msg> <fail-msg> <test-command...>
	# Wraps a condition so the pass/fail helpers are called via a real if/else
	# (avoids the `[ A ] && pass || fail` anti-pattern, where a failing `pass`
	# would wrongly trigger `fail`).
	assert() {
		local ok_msg="$1" bad_msg="$2"
		shift 2
		if "$@"; then pass "$ok_msg"; else fail "$bad_msg"; fi
	}

	# Portable temp dir (macOS mktemp wants a -t template; GNU does not).
	local root
	root=$(mktemp -d 2>/dev/null || mktemp -d -t shardselftest) || { echo "self-test: could not create temp dir" >&2; return 1; }
	trap 'rm -rf "$root"' RETURN

	# Fixture: mirror a monorepo layout so repo-root-relative paths are realistic.
	mkdir -p "$root/packages/x/tests/runtime/sub"
	local f
	for f in alpha bravo charlie delta echo foxtrot golf hotel india juliett; do
		printf 'describe(%s, () => {})\n' "$f" > "$root/packages/x/tests/runtime/$f.test.ts"
	done
	for f in kafka lima mike; do
		printf 'describe(%s, () => {})\n' "$f" > "$root/packages/x/tests/runtime/sub/$f.test.ts"
	done
	# Literal glob patterns (fully quoted); the helpers expand them internally.
	local glob1="$root/packages/x/tests/runtime/*.test.ts"
	local glob2="$root/packages/x/tests/runtime/sub/*.test.ts"

	# 1. count reports every matched file (10 top-level + 3 sub = 13).
	local total
	total=$(shard_split_count "$root" "$glob1" "$glob2")
	assert "count covers all 13 files" "count=$total, expected 13" [ "$total" -eq 13 ]

	# 2. union of all buckets == every file, with no duplicates and no gaps
	#    (the core guarantee that defeats silent file-drop regressions).
	local n=3 i=0 union union_unique bucket_files
	union=""
	while [ "$i" -lt "$n" ]; do
		bucket_files=$(shard_split_bucket "$root" "$n" "$i" "$glob1" "$glob2")
		union+="$bucket_files"$'\n'
		i=$((i + 1))
	done
	union_unique=$(printf '%s' "$union" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')
	assert "3-way union covers all 13 files exactly once" "union_unique=$union_unique, expected 13" [ "$union_unique" -eq 13 ]

	# 3. report sums to the total and emits one line per bucket.
	local report sum
	report=$(shard_split_report "$root" "$n" "$glob1" "$glob2")
	sum=$(printf '%s' "$report" | awk '{s+=$2} END{print s}')
	# Count non-empty lines: $(...) strips the trailing newline, so a bare wc -l
	# undercounts by one. grep -c . counts actual data rows.
	local lines
	lines=$(printf '%s\n' "$report" | grep -c .)
	assert "report bucket counts sum to 13" "report sum=$sum, expected 13" [ "$sum" -eq 13 ]
	assert "report emits one line per bucket ($n)" "report lines=$lines, expected $n" [ "$lines" -eq "$n" ]

	# 4. determinism: the same bucket resolves identically across calls and the
	#    hash itself is a stable non-negative 32-bit integer.
	local h1 h2
	h1=$(__shard_stable_hash "packages/x/tests/runtime/alpha.test.ts")
	h2=$(__shard_stable_hash "packages/x/tests/runtime/alpha.test.ts")
	assert "hash is deterministic across calls" "hash not deterministic ($h1 vs $h2)" [ "$h1" = "$h2" ]
	if [[ "$h1" =~ ^[0-9]+$ ]] && [ "$h1" -ge 0 ] && [ "$h1" -le 4294967295 ]; then
		pass "hash is a 32-bit integer"
	else
		fail "hash out of uint32 range: '$h1'"
	fi
	local b1 b2
	b1=$(shard_split_bucket "$root" "$n" 0 "$glob1" "$glob2" | wc -l | tr -d ' ')
	b2=$(shard_split_bucket "$root" "$n" 0 "$glob1" "$glob2" | wc -l | tr -d ' ')
	assert "bucket resolution is deterministic" "bucket size differs across calls ($b1 vs $b2)" [ "$b1" = "$b2" ]

	# 5. N=1 puts every file in bucket 0.
	local one
	one=$(shard_split_bucket "$root" 1 0 "$glob1" "$glob2" | wc -l | tr -d ' ')
	assert "N=1 places all 13 files in bucket 0" "N=1 bucket0=$one, expected 13" [ "$one" -eq 13 ]

	# 6. stability under addition: adding a new file never moves an existing
	#    file's bucket (the hash-only assignment is order-independent). This is
	#    the property that lets new files auto-route with no manual edit.
	local before after moved
	before=$(shard_split_bucket "$root" "$n" 1 "$glob1" "$glob2" | sed "s|^$root/||" | sort)
	printf 'describe(november, () => {})\n' > "$root/packages/x/tests/runtime/november.test.ts"
	after=$(shard_split_bucket "$root" "$n" 1 "$glob1" "$glob2" | sed "s|^$root/||" | sort)
	# Existing files are those present before AND after; none may change presence.
	moved=$(comm -23 <(printf '%s\n' "$before") <(printf '%s\n' "$after"))
	assert "adding a file does not move existing files out of their bucket" "files dropped from bucket on add: $moved" [ -z "$moved" ]

	# 7. argument validation rejects out-of-range buckets and non-integers.
	if shard_split_bucket "$root" 2 2 "$glob1" >/dev/null 2>&1; then
		fail "bucket_index == split_count should be rejected"
	else
		pass "bucket_index == split_count is rejected"
	fi
	if shard_split_bucket "$root" 0 0 "$glob1" >/dev/null 2>&1; then
		fail "split_count=0 should be rejected"
	else
		pass "split_count=0 is rejected"
	fi

	echo ""
	if [ "$failures" -eq 0 ]; then
		echo "shard-split self-test: all checks passed"
		return 0
	fi
	echo "shard-split self-test: $failures CHECK(S) FAILED" >&2
	return 1
}

# When executed directly (not sourced) with --self-test, run the self-test.
# BASH_SOURCE[0] == $0 only when the file is run, not sourced.
if [[ "${1:-}" == "--self-test" && "${BASH_SOURCE[0]:-}" == "${0}" ]]; then
	__shard_self_test
	exit $?
fi
