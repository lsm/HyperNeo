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
