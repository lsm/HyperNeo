# Artifact registration identity activation

Use proof-run.sh with lane-c-artifact-registration-identity.ts on native Bun and
cached Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup scrubs credentials and owns
fresh HOME/data, ephemeral listeners, resource checks and immediate data cleanup.
No provider turn, external GitHub, real native state or live daemon is used.

Commit the failing public RPC reproduction first. Refuse cached/new identity INSERT
and receipt SELECT on main during artifact.file.register. Cold admission rejection
must reject the RPC without capture, fallback or replay. Drop the next committed
reply: retain the identity, preserve the unknown-outcome rejection, publish no row,
and never replay automatically. Only a later explicit RPC may try initialization.

Hold a competing writer lock during two concurrent first successful registrations.
Both wait for one identity command; health remains responsive. After release, both
return exactly one receipt and one immutable row, proving the existing capture lane
is shared. A repeated request retains the receipt. Current ownership and sensitive/
traversal refusals remain authoritative; changing source produces a new immutable
revision and retries return that revision. Read the first snapshot through the
public read operation and observe the original bytes.

Scope the SQL guard honestly: registration must make zero main identity attempts.
Existing read-only snapshot authorization performs separate main identity SELECTs;
permit/count only that explicit verification phase. Row publication INSERTs also
remain on main until their later construction/activation rung. No claim is made
that the complete artifact subsystem has moved off main.

Pin the merged identity command/helper/constructor contract and exact hashes; measure
all local registration/stored-kind functions including closures to <=200 lines.
Pin unchanged policy, binding, capture-store and descriptor module source/import
hashes, but do not claim their complete transitive repository/runtime graph is
measured. FS/policy/ownership callbacks remain on main; only caller UUID crosses
into the identity transaction. Unit tests pin pending single-flight, rejection cache
cleanup and explicit retry without replay. Strict types, focused tests and root
checks are required. Append only the owned Deno smoke line. Native pinned Bun when
unavailable, browser and Neo-owned deployment smoke remain unverified.
