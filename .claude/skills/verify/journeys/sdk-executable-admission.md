# Unsupported SDK executables fail before query setup

Use the shared isolated proof wrapper and resource checks in ../SKILL.md.

    bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/sdk-executable-admission.ts

The helper owns a fresh daemon on an ephemeral loopback port, synthetic HOME
and data, a refusing GitHub stub and an authenticated local RPC socket. The
session.create door must reject a supplied executable field. Seed an unsupported
stored executable in a synthetic manual session, then require its actual query
options builder to reject with the value in the error. session.get must still
return that stored value and system.health must remain healthy. The persisted
configuration is rejected rather than silently reassigned. No SDK child or
model turn is started. Query-building rejection is observed directly on the
real session, separately from the public create/get/health RPC receipts.

Require all four flags in sdk-executable-admission.json, wrapper exit zero and
no closed-database errors. The helper closes the socket and daemon before the
wrapper removes its temporary data. Run existing native ACP safe-filesystem
tests under Bun to exercise the retained FFI path and permissions/race fences.
This journey does not claim Windows native FFI or a model-response proof.
