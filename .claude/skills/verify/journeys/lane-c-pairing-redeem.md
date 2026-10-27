# HTTP pairing redemption commits on the DB writer

Run `lane-c-pairing-redeem.ts` through `proof-run.sh` with Bun, then with
`VERIFY_PROOF_RUNTIME=deno` and the cached runtime on PATH. Use fresh evidence
folders. The helper owns an isolated daemon, ephemeral non-8399 port, synthetic
pairing codes/device credentials, fresh HOME/data, native DB workers and a
refusing GitHub stub. External HTTP and provider credentials are unavailable.
Only loopback requests to the owned HTTP server use the preserved native fetch.

Deny new and cached main statements for code claims, device insertion, pending
approval detection and recovery reset/read/invalidation. Commit the failing
HTTP reproduction before the fix: valid `POST /pair` must return 200, but the
baseline returns 500 with one target main SQL attempt. Fixture writes and
assertion-only reads leave measurement synchronously.

The fixed native response must follow a committed code claim and hashed device
insertion, and its credential must authenticate a real WebSocket. Browser-origin
HTTP returns an HTTP-only SameSite cookie and omits the credential from JSON;
focused route tests pin the Secure flag for HTTPS origins without claiming TLS
or browser-layout verification. Two requests for one code produce one 200 and
one 401. Two recovery codes produce one 200 and one 403, consume the recovery
window and invalidate the peer approval together. Pending approval remains 403
without incrementing failures; expired/invalid codes remain 401 and the failure
limit remains 429.

A competing WAL writer delays pairing while health responds and uncommitted
fixture state remains invisible outside its connection. Rejecting device insertion
rolls back the claim, reset and peer invalidation. Native worker failure before
posting leaves no device/claim; losing a native post-commit reply returns HTTP 500,
leaves exactly one committed device and causes no replay. A later independent
request recovers the writer. Save only statuses, flags and numeric timings/bytes;
never save raw codes, credentials or cookie values in evidence.

Record maximum loop lag, HTTP/health timings, worker round-trip/encoding metrics,
RSS and WAL size. SQL, queue and clone time are not isolated. Close all owned
transports/processors/workers/daemon, save JSON, then immediately delete temporary
data through the wrapper. Code creation, device diagnostics, reset operations,
large-volume performance, deployed-build behavior and browser layout remain outside
this slice. The diagnostic pending-code read used to check authentication is not
included in the target SQL ownership claim.
