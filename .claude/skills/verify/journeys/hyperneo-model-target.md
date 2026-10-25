# HyperNeo work targets resolve model names and effort

```bash
RUN=$(mktemp -d /private/tmp/hn-model-target-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/hyperneo-model-target.ts "$RUN"
```

The helper owns an isolated daemon, synthetic custom endpoints, temporary HOME
and database, GitHub stub and ephemeral non-8399 listeners. It invokes the same
WebSocket operations used by the app. Model discovery must expose id/name/provider;
a unique case-insensitive display name must start on that provider; a duplicate
name must refuse with both IDs without creating a session; an exact ID must win.
A uniquely named offer must retain its provider even when IDs are shared. An
exact shared ID retains catalog precedence; it does not become a name ambiguity.
HyperNeo effort must appear in the work receipt and session thinking readback
before the queued input is processed. Effort casing and repeated whitespace must
normalize to the same thinking level. Evidence is `evidence/observed.json`.
All resources close in finally. This metadata/admission proof does not assert
model inference or provider-specific reasoning output; the endpoint is synthetic.
