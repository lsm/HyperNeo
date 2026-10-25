# Worker batches stay separate from human input

Follow the shared in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-human-batch.ts`. Preflight port 8000, build the
web app first, and use a fresh run with its own HOME and data. The helper owns
the model mock, daemon, static web listener and refusing GitHub stub. External
MCP servers and SDK sandboxing are disabled only for this transport proof.

Queue two small worker messages through message.send, then send a whitespace-
sensitive human message through neo.message.send. The first note includes a PNG;
the image must reach Neo's SDK/model input while the public disclosure contains
only worker text, without raw image JSON or base64. Repeat with 35 worker notes
of 2,048 payload bytes each, so no individual send uses the existing 4 KiB file
path while the combined batch exceeds 64 KiB. Observe separately persisted
system-forwarded worker input, unchanged effective human content, human words
inline at the actual model API, and the worker-only handoff read in full through
handoff.read. Every worker note must survive in order; no human words may enter
that file. Public neo.conversation.read must place the labelled batch before
the unchanged human ask.

Use --hold-ui to keep the owned web listener alive for at most two minutes.
For headless-only verification, run neo-human-batch-headless.mjs with the run
directory. VERIFY_PLAYWRIGHT_MODULE may select an installed Playwright module
and VERIFY_CHROMIUM a compatible Chromium executable. The script uses a fresh
headless context, restricts requests to the isolated UI origin, expands the
worker disclosures, checks order and reload, and closes its resources. It writes
the run's finish-ui file to close the owned listeners promptly. Never launch a
GUI browser on a locked Mac.

If headless launch is denied or unavailable, do not retry through another route.
Label browser verification unverified. Run the real rendered component against
the saved daemon pages instead: from packages/web, set VERIFY_NEO_BATCH_RUN to
the run directory and execute bunx vitest run src/neo/__tests__/NeoWorkerBatch.test.tsx.
Keep render.log and rendered-*.html. This fallback proves labels, order,
disclosure interaction and remount from actual daemon data, not browser layout
or browser reload. Retain headless-unverified.json and headless.log as well.

Keep evidence/observed.json, the public conversation pages, worker-handoff.json,
model requests and any successful headless screenshots/page text.

Before the fix, the human's effective content includes the worker batch, the
oversized model input hides the human words in the same handoff file, and the
public transcript/UI has no batch entry. Commit that failing reproduction first.
The fixed unit contracts also preserve the original human SDK envelope and
exercise delivery order, retry identity and independent bounding. Daemon and
rendered-component evidence proves synthetic transport and presentation; claim
browser behavior only when the headless check passes. This does not prove a live
rollout, real-provider reasoning or OS sandbox enforcement.
