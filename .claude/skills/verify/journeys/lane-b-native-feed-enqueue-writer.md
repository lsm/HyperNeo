# Native-feed job admission through the writer

Run `lane-b-native-feed-enqueue-writer.ts` with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, HOME=<run>/home and HYPERNEO_DATA_DIR=<run>/data.
It owns an ephemeral non-8399 daemon, restores its startup observer and stops all
owned processors before seeding. Native roots resolve only inside the disposable
HOME and contain no transcripts. No credentials, native agents, providers, HTTP
mock, UI or live daemon are involved.

Defer only the synthetic daemon's unrelated jobs, then seed due Claude and Codex
feed jobs. Tick its actual registered processor and deny job_queue SQL from the
two scheduling helpers/new command on main. Both jobs must complete with zero
files/turns and retain one future pending successor with the original scope and
retry budget. Concurrent scheduling retries must preserve that successor and due
time. Real health RPCs bracket the path. The baseline must record forbidden main
admission SQL; fixed Bun/Deno proofs must record zero target main SQL.

Focused tests cover receipt waiting, concurrent admission, failures and both
existing feed pipelines. RPC setup must await bootstrap scheduling, including its
explicitly approved core-owned companion await at the app call site. Save
evidence/native-feed-enqueue-writer.json before deleting owned temporary data.
This does not prove production-mode startup, transcript ingestion SQL migration,
native agent interaction, UI, real worker death, contention or large-payload latency.
