# Observe connected device revocations

Run lane-c-connected-device-observer.ts through proof-run.sh with Bun, then Deno.
The wrapper isolates HOME/data, provider credentials and GitHub, uses ephemeral
listeners and removes temporary data after preserving evidence. Record actual
versions: local Bun 1.4.3 does not establish pinned Bun 1.4.2 native coverage.
The separate Deno proof uses the installed pinned Deno 2.9.4. No runtime install,
provider turn, live daemon or port 8399 is needed.

Commit the failing connection-observation proof first. The trigger is the already
registered data-only revocation command: lose its successful native reply and
confirm persisted inactive state. This models a missing mutation notification;
the public revocation mutation remains a separate activation slice. The observer's
actual user surface is the existing authenticated WebSocket connection and the
real CLI devices reader.

Self-check new and cached main SQL traps, then deny active-device and revocation
SQL on main. Seed paired active, revoked, duplicate and disconnected clients plus
an unpaired connection. Inspect fixtures synchronously outside measurement.
Hold a reader reply across two ticks: only one batch may be in flight and health
must answer. The batch must contain deduplicated currently connected device IDs,
excluding unpaired and departed clients. Reject reads for over two seconds: no
connection may close on an unconfirmed state and starts remain at most one per
second. Restore the reader: both revoked connections close, active/unpaired stay
open, CLI reports revocation, and the mutation is never replayed.

Hold a later confirmed-inactive reply and release it from the real transport close
hook during daemon cleanup. No late revocation notification or later polling may
occur. Save flags, byte/timing metrics, RSS and WAL only, never IDs, credentials,
codes or CLI output. Loop lag and health latency are measurements of this synthetic
fixture; SQL/queue/clone time are not isolated. Remeasure the full observer call
graph and changed production lines before publishing; each slice must fit 200.
Native cleanup must complete without database-close errors. Browser layout,
public mutation activation and deployment remain unverified in this foundation.
