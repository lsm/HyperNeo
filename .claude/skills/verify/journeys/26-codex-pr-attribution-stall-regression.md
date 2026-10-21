### Codex PR attribution stall regression (journey 26)

Run a synthetic Codex database/transcript through the real `work.status` door:

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-pr-lag-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/codex-pr-lag-check.ts 9347 "$RUN"
```

Use a free non-8399 port and a fresh run directory. The helper creates its own
Codex state DB under the temporary HOME before daemon startup; no real Codex
store, transcript, keys or credential discovery is used. Its 4,011,712-byte
transcript has normal synthetic padding plus a tool-documentation line with
32,000 unmatched `pull_request` tokens after `attach_artifact`. The old nested
lazy regex revisits the suffix for every token: it takes seconds, whereas the
new scan advances monotonically through non-overlapping parenthesis segments.

End state: `observed.json` preserves the first/unchanged/appended/truncated PR
lists, RPC elapsed times and maximum 10 ms heartbeat lag. Max lag must be below
1,000 ms; the helper writes the evidence before asserting the budget, so the old
code's failing reproduction remains measurable. This is an adversarial synthetic
line in a realistic tail size, not a copy or an estimate of the real transcript.
The helper stops its daemon and timer in `finally`; no GUI, providers or profiling
flag are involved. This proves the daemon RPC path, not deployed performance.

An unchanged transcript tail skips PR extraction, using a SHA-256 digest of the
already-read lines. File timestamps are not cache identities: coarse timestamps
can repeat after a same-size rewrite. Only the bounded PR result and digest are
cached in the adapter's lifetime; status/reply and exchange reads continue. Append,
equal-size rewrite, replacement, changed tail window and truncation must invalidate
it; `codex-pr-cache.test.ts` pins those
observable results. No raw transcript is retained in the cache.
