19. **Daemon performance has a repeatable read-only tally.** Run
    `bun scripts/daemon-lag-tally.ts <log> [--timestamps <jsonl>] [--since <ISO>] [--until <ISO>]`.
    It accepts timestamped console lines or JSONL directly. The laptop console
    log has no timestamps, so use its structured mirror to date the matching
    lag-event suffix, never the file's modification time:

    ```bash
    UNTIL=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    SINCE=$(bun -e 'console.log(new Date(Date.parse(process.argv[1])-86400000).toISOString())' "$UNTIL")
    bun scripts/daemon-lag-tally.ts ~/.hyperneo/logs/laptop-daemon.log \
      --timestamps ~/.hyperneo/logs/daemon.jsonl --since "$SINCE" --until "$UNTIL"
    ```

    End state: Markdown tables show UTC daily block counts, watchdog unresponsive
    counts, worst block, and each day's SQL groups ranked by total blocked time.
    SQL literals and bind parameters use the existing storage normalizer.
    `no SQL` means no slowest statement was logged; it does not prove pure JS.
    Blocked durations are attributed to the accompanying SQL label, not measured
    SQL time. Watchdog notices can describe the same incident as a later block;
    their durations are not added to blocked time. SQL labels may already be
    truncated by the logger. These records cannot prove every hot query is under
    250 ms; inspect `sqlite.query.slow` separately for that goal.

    Window bounds are inclusive `since`, exclusive `until`, with timezone required.
    Undated events are shown separately without bounds, or counted as excluded
    with bounds. A mismatch between console and JSONL event suffixes fails rather
    than guessing dates; use matching snapshots or pass JSONL directly. Save the
    output and exact window as evidence, and disclose missing timestamp coverage.
    No database or credentials are opened, and no daemon is launched or changed.
    Synthetic CI coverage lives in `tests/unit/lib/daemon-lag-tally.test.ts` in
    the daemon package; run just that file locally.
