# OAP delivery without provider login

Use shared isolation and pinned Bun from `../SKILL.md`. Run `proof-run.sh` with
`oap-provider-admission.ts` and a fresh evidence directory on a build host.

The helper starts an isolated daemon and synthetic OAP stdio hub. It adds the
synthetic OXAP Codex provider record from `oxap-codex-provider.ts` (its key lives
only in the temporary database) and no login for the SDK provider. The Codex
session takes its harness from that record, retains a legacy stored tool preference,
then the global permission changes to plan. The session completes one RPC message through
the production OAP adapter. The SDK session must not fall back onto the OXAP
provider. An SDK session in the same daemon keeps its
message enqueued and displays the provider-login notice. Evidence records one OAP
submission, one Codex result, one SDK enqueued message and zero SDK results.
