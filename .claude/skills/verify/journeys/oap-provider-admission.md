# OAP delivery without provider login

Use shared isolation and pinned Bun from `../SKILL.md`. Run `proof-run.sh` with
`oap-provider-admission.ts` and a fresh evidence directory on a build host.

The helper starts an isolated daemon and synthetic OAP stdio hub. Without
configuring an ordinary provider login, a Codex session completes one RPC message
through the production OAP adapter. An SDK session in the same daemon keeps its
message enqueued and displays the provider-login notice. Evidence records one OAP
submission, one Codex result, one SDK enqueued message and zero SDK results.
