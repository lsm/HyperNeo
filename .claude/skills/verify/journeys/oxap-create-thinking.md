# Create a chat with an OXAP provider

Build the web UI, then run `bash .claude/skills/verify/oxap-create-thinking.sh <evidence-dir>` with pinned Bun, Node 24, `PLAYWRIGHT_NODE_PATH` and `VERIFY_BROWSER` set. It owns an isolated daemon, seeds an OXAP provider and synthetic model, pairs a browser and cleans up. Port 31397 must be free.

A failed provider lookup shows an error and Retry restores the form. The create form hides thinking and sandbox for OXAP, even with persisted `off` thinking and enabled sandbox selections. Creating a chat succeeds; light and dark screenshots show the form. The fixture supplies a synthetic model catalog and does not make a model turn.
