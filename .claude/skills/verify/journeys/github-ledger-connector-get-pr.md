# Ledger-owned connector PR facts (Build)

Use shared isolation in `../SKILL.md`. No model or HTTP mock is needed.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-connector-pr-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-connector-get-pr.ts "$RUN"
```

The helper owns an actual daemon with a synthetic DB and invokes the new local
reader through `createNeoCodingReaders`. This is a Build proof; production
`connector.getPr` and readiness callers are unchanged and still make direct
reads until their separate Wire slice. It adds no RPC, permission, schema or
scheduler. No GUI, provider keys, credential files, live DB or port 8399 is used.
Fake gh refuses unknown commands, direct HTTP throws, and cleanup runs in finally.

Pass: `evidence/connector-pr.json` has `verified: true`, five identical cold
results with all four original fields and `coldReads: 1`. Run the same helper
with third argument `baseline` for the unchanged connector: five identical
requests produce five actual gh calls. Save both `requests.jsonl` files.
Every sequential demand refreshes, including a recent OPEN-to-MERGED change;
this slice introduces no freshness shortcut to mutation admission. Missing
mergeability or a failed latest lookup refuses, retaining prior JSON and its
successful observation time. Recovery succeeds. Repository aliases coalesce;
foreign hosts fail without acquisition. These are logical gh invocation counts,
not GraphQL cost, live quota, or deployed connector API savings.

Run the connector ledger, existing connector and preset suites plus full checks
on the final head. Unit contracts additionally cover UNKNOWN mergeability,
reader reconstruction, retryable rate limits, wrong identity and superseded
responses. Preserve evidence before deleting the isolated run. After merge,
verify automatic rollout using owner RPC; never deploy or restart the live
owner. Wire follows from fresh dev and must prove the real workflow hook path.
