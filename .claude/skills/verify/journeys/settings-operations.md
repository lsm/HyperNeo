# Settings operations over RPC

Run `bash .claude/skills/verify/settings-operations.sh <port>` with Bun 1.4.2 on PATH after building the web bundle. The script starts an isolated daemon and reads the default model, rejects an unavailable model, and reads usage for a missing provider over RPC. It asserts the exact missing-provider reply and clean shutdown. Compare its JSON output with the base revision for unchanged responses. No provider credentials or model turns are used.
