## Shard enumeration CI responsiveness

The user surface here is the shard CLI and CI coverage report, so no daemon or
browser is needed. Run `bun run test:ci-balance-report` and
`bash scripts/lib/shard-split.sh --self-test`, then
`./scripts/test-daemon.sh --verify`. The bounded-latency fixture inserts 30 ms into
each external checksum invocation: 128 files must still enumerate in two seconds.
Before batching this fails with `ETIMEDOUT`; it models process overhead, not actual
CI runner latency. UTF-8 and paths over 255 bytes must match system POSIX `cksum`.
The raw-byte CLI fixture must preserve invalid UTF-8 bytes in both the checksum
and emitted path; decoding through a JavaScript string fails this regression.

To compare every assignment against the original emitter at unchanged file/weight
inputs, run this from the current worktree (no live data, providers or GUI):

```bash
RUN=$(mktemp -d /private/tmp/hn-shard-parity-XXXXXX)
git show 72fee50872:scripts/lib/shard-split.sh > "$RUN/baseline.sh"
for suite in daemon online; do
  for variant in baseline current; do
    bash -c '
      source "scripts/test-$1.sh"
      if [ "$2" = baseline ]; then source "$3/baseline.sh"; fi
      if [ "$1" = daemon ]; then
        for shard in "${SHARDS[@]}"; do
          printf "%s\n" "$shard"; shard_paths "$shard"
        done
      else
        online_all_modules | while IFS= read -r module; do
          printf "%s\n" "$module"; online_module_paths "$module"
        done
      fi
    ' shard-parity "$suite" "$variant" "$RUN" > "$RUN/$suite-$variant.txt"
  done
  cmp "$RUN/$suite-baseline.txt" "$RUN/$suite-current.txt"
done
```

Both `cmp` calls must succeed. Retain the output files with the real CLI/report
logs and timings. This checks identical hashes, bucket membership and ordering
for the current source population, not model/session delivery or CI runner health.
