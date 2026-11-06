# Extract new GitHub watched-repository INSERT

Run proof-run.sh with lane-c-github-watched-insert-extract.ts under Bun. Shared setup owns
scrubbed HOME/data, free ephemeral port, evidence and cleanup. No model/HTTP mock or
credentials. Never touch live daemon/8399, deployment or real HOME. Refuse external
HTTP/gh, disable webhook reconciliation, use an injected 60-second poll interval and close
the owned timer before it fires. Finish body copying and stop processors.

Seed two synthetic Spaces with empty watch lists; disable the primary source.
Through watchRepo create the primary with no enabled override (Space fallback
false), enable that existing row, then create a polling peer (default Space true).
Pin UUID/creation time, defaults, fallback, identity and saved config. Observe
three native writer posts, two created rows and zero main INSERTs. Compare final
row time with its receipt. A non-polling insert retains its initial clock; the
polling peer may have a later update clock from cursor persistence. Its activation
marker still equals creation time. Exact initial INSERT bindings remain in the
scratch/unit contracts below. This retains extraction coverage after activation.

Scratch SQLite has only the watched table. INSERT uses its supplied id, resolved Space
flag and time even when params differ; no clock, UUID or initialization. Pin
defaults/nulls, duplicate-id failure without replay, and caller rollback. Normalize only
SQLite row prototypes across Bun before comparing all values. Focused tests compare exact
legacy/helper SQL/bindings/raw rows before cursor policy, across source/param flags, null,
empty and zero cases. Check single failed attempts and unchanged peer rows. Full-file
hash/interface tests pin the five stable dependencies, including rollback and
supplied-time UPDATE contract.

Run measurement in the unmerged slice branch; after merge use saved evidence.
Neo approved fresh 146, excluded 166, total known 312. The fifth audited stable
module is the complete 64-line UPDATE helper; #9418 tracks all five. Pin full
hashes/contracts and test interfaces. No full public/shared-barrel/runtime
transitive closure claim. Keep UUID/time/Space fallback in the caller, and
UPDATE/cursor/reset/webhook policy unchanged. If review challenges the envelope,
stop/report. Any later additional exclusions require a new table/Neo decision.
Reduced UPSERT, command and public wiring remain separate remeasured slices.

Save github-watched-insert-extract.json. Close scratch DB/socket/processors/app,
restore hooks in finally and remove owned temporary data through the wrapper.
Deployment smoke stays with Neo.
