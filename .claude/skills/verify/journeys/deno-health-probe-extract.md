# Extract the legacy authenticated health probe

Use the shared resource and synthetic HOME/data rules in ../SKILL.md. Install
the CI-pinned Deno 2.9.4 on the owning shell's PATH; never change a live daemon.
This extraction keeps Deno as the executing runtime. The program belongs under
packages/daemon/scripts so Deno retains the daemon package's pinned npm scope;
moving it to root scripts changes dependency resolution even with --config.

Run the affected unit files under the isolated unit setup: deno-health-extract,
deno-smoke-arguments, native-proof-parity and bun-daemon-boot-probe. The original
inline fixture and extracted program must format identically. Network fixtures
must preserve authenticated success, unrelated/malformed messages, unexpected
status, RPC rejection and handshake rejection, including exit status, output
and request shape. These fast cases run both programs under a Bun-hosted Deno
API adapter; they are not evidence of Deno runtime compatibility.

Require the real Deno fixture-isolation journey too. Choose a free non-8399
port for DENO_SMOKE_PORT and run its Python helper with the pinned Deno on PATH,
a disposable HOME and DENO_DIR, and TMPDIR=/private/tmp on macOS:

    python3 .claude/skills/verify/deno-smoke-fixture-isolation.py

This starts the actual isolated source daemon and executes the extracted
program through the real shell invocation. Require HTTP 200, WebSocket OPEN,
system.health ok, SDK status/page/live reads, migrations, graceful shutdown,
the stopped-before-fixture-write fence and completion of the whole native smoke.
A PASS followed by cancellation or cleanup failure is a failure.

Keep the wrapper exit status and log outside the disposable run. Preserve all
117 ordered helper commands byte-for-byte; refresh only the runner source hash
after auditing the inline-to-file move. Shell tests must preserve environment
values and single filename arguments even when checkout and temp paths contain
spaces. The existing TMPDIR normalization tests remain required.

Only formatting and the run-versus-eval invocation change in this extraction.
Timeouts, credential reads, response filtering and failure policy stay pinned
to the historical program. No claim that the 117 feature helpers have migrated
to Bun, or that CI's Deno check can be removed.
