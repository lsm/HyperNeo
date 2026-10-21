### Opt-in JSC source attribution for lag (journey 25)

Repeat journey 25 with `HYPERNEO_LAG_PROFILE=1` in its isolated `env -i` command.
The helper must now observe `samplingProfile.status=captured` with the real
`lagProfileSyntheticHotspot` function in `lag-activity-check.ts` and a positive
source line, while preserving the original lag warning and payload privacy.
Repeat without the flag: `samplingProfile` must be absent. This enables profiling
only in that synthetic process, never on the laptop daemon.

Measure steady overhead in separate fresh run directories, alternating the flag
off/on/off/on, with the same isolation variables and a free non-8399 port:

```bash
RUN=$(mktemp -d /private/tmp/hn-lag-profile-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/lag-profile-overhead.ts 9346 "$RUN"
```

Add `HYPERNEO_LAG_PROFILE=1` only for the on runs. Each `overhead.json` records
12,000 real synthetic RPCs after 1,000 warmups: CPU, wall time, p50 and p95.
Both helpers stop their daemon and monitor in `finally`. These measurements
cover a synthetic workload, not the laptop heap or normal human activity.

Profiling activates when the existing lag monitor is armed after startup
settles (or its startup grace expires), not before initialization. Disabled is
zero profiler work; runtimes without the Bun API report `unsupported`.
The sampler interval is 10 ms; every 250 ms monitor tick drains native samples,
including healthy and rate-limited ticks. Only the newest 2,000 samples are
ranked; any omitted count is explicit. Output is five stacks, six frames each,
function names up to 120 characters and source paths up to 300; source URL
queries/fragments and inline source bodies are excluded. Unknown source lines
are null. Three reports per rolling hour limit log volume. The coverage is
between profiler drains, approximately the monitor tick, with small boundary
skew from the monitor's own work. Async/native code may lack useful JS frames.
JSC sampling runs for the enabled process lifetime; disabling it requires a
separate authorized restart. Never set this flag on the live daemon without
explicit approval from Neo/human. A captured stack is attribution evidence;
these synthetic runs do not establish the cause of the real laptop stalls.
