# Refused Neo input and explicit retry

Run `neo-front-refusal.ts` through `proof-run.sh` with pinned Bun and the shared
isolated daemon setup. The scripted provider accepts Front's acknowledgement,
then refuses Neo's turn with HTTP 400. The public conversation reader must
expose the input as failed with the provider reason. An explicit retry creates
one fresh input carrying the same content and a link to the failed input. A
second retry is refused; the fresh input is consumed, the original remains failed
and its consumed sequence stays unchanged. The provider fixture permits the new
turn and must see no further refusals after the explicit retry.

Retain `neo-front-refusal.json`, `proof.log` and wrapper exit status. Require
`passed`, `retryConsumed`, `originalSequencePreserved`, and `resourcesClosed` to
be true, with wrapper exit 0. The fixture owns its daemon and loopback provider.
