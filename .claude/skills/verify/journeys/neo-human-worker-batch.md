# Worker batches stay separate from human input

Follow the shared in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-human-batch.ts`. Preflight port 8000, build the
web app first, and use a fresh run with its own HOME and data. The helper owns
the model mock, daemon, static web listener and refusing GitHub stub. External
MCP servers and SDK sandboxing are disabled only for this transport proof.

Queue two small worker messages through message.send, then send a whitespace-
sensitive human message through neo.message.send. Repeat with 35 worker notes
of 2,048 payload bytes each, so no individual send uses the existing 4 KiB file
path while the combined batch exceeds 64 KiB. Observe separately persisted
system-forwarded worker input, unchanged effective human content, human words
inline at the actual model API, and the worker-only handoff read in full through
handoff.read. Every worker note must survive in order; no human words may enter
that file. Public neo.conversation.read must place the labelled batch before
the unchanged human ask.

Use --hold-ui to keep the owned web listener alive for at most two minutes. Open
the printed /neo URL, observe the small and large batch disclosures before their
human asks, expand one and confirm worker text, then reload and confirm they
remain. Keep screenshots and the observed page text with evidence/observed.json,
the public conversation pages, worker-handoff.json and model requests. Create
the run's finish-ui file to close the owned listeners promptly.

Before the fix, the human's effective content includes the worker batch, the
oversized model input hides the human words in the same handoff file, and the
public transcript/UI has no batch entry. Commit that failing reproduction first.
The fixed unit contracts also preserve the original human SDK envelope and
exercise delivery order, retry identity and independent bounding. This proves
synthetic daemon/SDK and browser behavior, not a live rollout, real-provider
reasoning or OS sandbox enforcement.
