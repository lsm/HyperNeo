# Custom Anthropic endpoints honor Thinking Off

From the repository root, run the isolated proof with pinned Bun and a fresh
evidence directory.

```bash
bash .claude/skills/verify/proof-run.sh /tmp/thinking-off-evidence .claude/skills/verify/custom-endpoint-thinking-off.ts
```

The helper uses the real custom provider and its Anthropic HTTP bridge with a
local upstream fixture. It checks Off, High and Auto for two arbitrary model IDs
with and without the endpoint-level llama.cpp compatibility option. Off sends
the Anthropic disabled value together with the template switch when
compatibility is selected. High forwards the budget, and Auto keeps the model
default. Off with compatibility enabled also strips both effort overrides so
they cannot re-enable thinking. Send a response format for one model and
effort alone for the other. Off with compatibility should omit the
effort-only output config and preserve the response format when supplied.
The other cases forward effort unchanged, and all cases preserve unrelated
template settings.
Require twelve successful requests across the two cases.

In the web app, open Settings, Connections & Services, Providers. Edit an
Anthropic Messages custom endpoint. Enable "llama.cpp compatibility for Thinking
Off", save, and reopen the editor to confirm it persisted. This option applies
to every model on the endpoint. Check that the option is hidden when the
endpoint type is OpenAI Chat Completions or Ollama Native.
