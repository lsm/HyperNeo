# OpenCode Go with DSH

Use the isolated setup and verified OXAP release described in
[First message in an OXAP DeepSeek chat](oxap-deepseek-first-message.md).
Run the same RPC journey with the OpenCode Go fixture:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-deepseek-first-message.ts /absolute/oxap RELEASE-NAME SHA256 opencode-go
```

The daemon stores separate synthetic keys for OpenCode Go and DeepSeek over
RPC. Saving the Go harness rejects a missing executable and a different
CLI, then accepts the DSH peer. An OpenCode Go session chooses DSH while its
provider default is SDK.
The native peer checks the Go endpoint and key reference in the overlay and
requires that only the Go key reaches its process. Its reply reports the model
bound by the hub. The journey changes the provider default, sends a follow-up,
and verifies that the original native session reopens with the same model.

Repeat with `opencode-go-alias` and a fresh evidence directory to configure the
provider with only `OPENCODE_GO_API_KEY` in its injected environment. This
checks readiness and the child key name without setting a daemon environment
credential.

With `opencode-go-with-unkeyed-route`, also save an OpenCode Go route for the
DeepSeek provider while the daemon environment has no OpenCode key. Confirm
the direct OpenCode Go harness still replies with its stored key and that the
hub omits the separate DeepSeek route.
