# Pairing v2 approval admission

`/pair2/approve` admits any active paired human phone: a `paired_devices` row
with `kind = 'human'` and `revoked_at IS NULL`, excluding `local-rpc:*` and
`agent-read:` synthetic ids, regardless of pairing version or owner bit. The
same admission governs the pending list once it lands; bootstrap eligibility
is a separate rule, defined below. Identities minted by the local transport
(`local-rpc:*`) and read-only agent credentials (`agent-read:*`) are refused
only on approve: request, deny and cancel admit any authenticated human
identity, including the local web session. Deny and cancel only terminate a
request.

A ticket issued while no human phone has ever been paired, or while a lost-phone
reset is open, is a first-device ticket. Its completion needs only the bound-key
proof and atomically rechecks that same window, so it grants the first device and
its owner bit with no separate approval. Ordinary revocation does not reopen the
window, and a later-device ticket cannot become a bootstrap ticket.

The approve route refuses first-device requests: they never appear as approvable
and completing one after another phone has paired returns `cancelled`. Legacy
typed-code pairing remains available and shares the same atomic active-phone
check inside its grant transaction: if either path grants the first device, the
other path refuses its outstanding first-device attempt. A first-device grant
also un-approves unused human pairing codes; a later-device completion leaves
them alone.
