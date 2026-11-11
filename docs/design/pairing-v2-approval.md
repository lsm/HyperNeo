# Pairing v2 approval admission

`/pair2/approve` admits only an active paired human owner device. Identities
minted by the local transport (`local-rpc:*`) and read-only agent credentials
(`agent-read:*`) are refused on every request, including the first. Deny and
cancel only terminate a request; they keep the authenticated human-session
admission, including the web session.

A fresh install therefore has no identity that can approve a v2 request over
HTTP. First-device approval is reserved for the OS-verified native signer in
the Mac-trust slice: it proves possession of the machine's protected key and
calls `approveRequest` on the database worker lane directly rather than through
`/pair2`. Until that slice lands, v2 stays behind `HYPERNEO_PAIRING_V2` and no
unapprovable flow is reachable; the legacy typed-code `/pair` flow is unchanged
and remains how the first device joins.

`approveRequest` refuses `local-rpc:*` and `agent-read:` approvers
unconditionally, at any owner count: the first owner comes only through the
signer path. Its atomic `grants_owner` check stays so exactly one first-owner
grant survives concurrent approvals.
