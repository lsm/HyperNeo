25. **A blocked daemon tick identifies recent work without logging message bodies.**
    Run the same production diagnostic attachment on an isolated test daemon:

    ```bash
    RUN=$(mktemp -d /private/tmp/hn-lag-attribution-XXXXXX)
    env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
      bun .claude/skills/verify/lag-activity-check.ts 9344 "$RUN"
    ```

    This uses a new synthetic DB and a real WebSocket RPC whose test-only handler
    blocks for 1.35 s. It never registers that handler in production. The helper
    explicitly attaches the production monitor because test mode skips the
    watchdog that normally arms it. End state: `$RUN/observed.json` contains the
    unchanged lag line, matching incoming/outgoing RPC names and periodic phase
    timing, before/after heap fields, runtime GC coverage and sampler latency.
    A phase from a previous tick and a private RPC body marker must be absent.
    The helper stops its daemon and monitor in `finally`; it starts no model,
    browser or real credentials. Heap latency is measured on its synthetic heap;
    real-heap overhead is guarded by the runtime 1 ms sampling budget.
    See [the phase inventory](../lag-phase-inventory.md) for timer defaults and
    diagnostic limits. A recent activity is correlation, not proof of cause;
    asynchronous phase duration includes awaits. This journey proves diagnostic
    output, not the cause of any real laptop block. Live logs remain read-only.

    To reproduce the post-restart diagnostic overflow with synthetic activity:

    ```bash
    RUN=$(mktemp -d /private/tmp/hn-lag-burst-XXXXXX)
    env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
      bun .claude/skills/verify/lag-activity-burst.ts "$RUN"
    ```

    The isolated daemon uses an ephemeral port. Its real WebSocket RPC records
    an early 1.35 s blocking phase followed by 138 metadata phase pairs. The
    resulting 281 records cover the live startup tick's 249 records and a later
    steady-state tick's 280 records. The earlier 122-pair fixture reproduced the
    startup tick's 64 retained plus 185 dropped; 138 pairs also overflowed the
    intermediate 256-record cap. End state: `observed.json` retains that early
    phase and reports zero drops within the bounded 512-record ring. Larger
    bursts still drop the oldest records and disclose the drop count. The helper
    stops its daemon in `finally`. This proves retention and payload privacy,
    not scanner causality or a fix for physical disk stalls.
