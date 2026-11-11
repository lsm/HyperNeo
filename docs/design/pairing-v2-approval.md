# Pairing v2 approval admission

`/pair2/approve` and `/pair2/deny` admit only a non-synthetic paired human
device. Identities minted by the local transport (`local-rpc:*`) and read-only
agent credentials (`agent-read:*`) are refused on every request, including the
first.

A fresh install therefore has no identity that can approve a v2 request over
HTTP. First-device approval is reserved for the OS-verified native signer in
the Mac-trust slice: it proves possession of the machine's protected key and
calls `approveRequest` on the database worker lane directly rather than through
`/pair2`. Until that slice lands, v2 stays behind `HYPERNEO_PAIRING_V2` and no
unapprovable flow is reachable; the legacy typed-code `/pair` flow is unchanged
and remains how the first device joins.

`approveRequest` keeps its atomic first-owner gate in the same transaction that
flips the request: a `local-rpc:*` approver is refused while owners exist, and
the empty-owner branch exists for the signer path, not for HTTP callers. Before
the signer lands, that branch is exercised only by repository and route tests.
