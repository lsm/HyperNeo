# Pairing code creation uses one writer admission

Run `lane-c-pairing-code-create.ts` through `proof-run.sh` with Bun, then with
`VERIFY_PROOF_RUNTIME=deno` and the cached Deno on PATH. The real session-door
probe launches the existing Bun CLI under the same disposable HOME/data and an
explicit path to the owned daemon socket. No install, real credential, model,
external HTTP or port 8399 is used. Keep evidence folders separate.

Deny new and cached main statements for device counts, active-device lookup,
recovery lookup and pairing-code insertion. The baseline real WebSocket operation
must fail on forbidden main SQL; commit that failing proof before the fix. Fixture
setup and assertion reads leave measurement synchronously.

On a fresh daemon the local bootstrap code is approved and already committed when
returned, with only its hash stored. After pairing that human, unpaired requests
and the real CLI issue pending codes; the active human issues approved codes.
Concurrent requests retain independent committed codes. A connected but revoked
human, an unpaired caller and the CLI are refused when no active human remains.
An explicit synthetic recovery window permits a replacement human code from the
real session door but refuses relay codes. Redeeming the replacement consumes the
existing recovery window.

While a competing WAL writer stages that human's revocation, queue an issuance
from its already-authenticated socket. Health must respond; uncommitted fixture
state stays invisible to another connection. Commit the revocation: the queued
command must recheck current authorization and refuse without inserting a code.
This pins the read/decision/write transaction boundary. A rejecting INSERT trigger
rolls admission back. Native worker failure before posting inserts nothing; losing
a post-commit reply rejects with unknown outcome, retains one code, and causes no
replay. A later independent request recovers the writer.

Save flags, refusals and numeric timings/bytes only, never raw codes, credentials
or CLI output. Record RPC/health latency, maximum loop lag, worker round-trip and
reply encoding, RSS and WAL. CLI process startup is measured separately from the
RPC latency threshold; SQL, queue and clone times are not isolated. Close owned
sockets, processors, workers and daemon, save JSON, then let the wrapper immediately
remove temporary data. Other pairing operations, browser layout and deployment
remain outside this ownership claim.
