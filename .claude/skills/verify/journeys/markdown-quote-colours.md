# Markdown quote colours

Use shared isolated launch, resource checks and cleanup from SKILL.md. Open Neo
through rpc.ts, stop the owned daemon, then seed markdown-quote-colours-seed.ts
with the temporary run directory and returned Neo session ID. Restart it. Use
no real keys/accounts, human profile or production data; choose unused ports.

Import verifyQuoteColours from markdown-quote-colours-proof.mjs into an owned
Playwright session. Pass {run,base,phase,theme}, using before/after and dark/light.
For after, also pass the matching before JSON as baseline. Capture both themes
before changing CSS and again from the fixed build. Inspect the actual Neo quote,
its matching border and italic style. The helper composites actual ancestor
backgrounds, requires contrast >=4.5 and the existing 6% overlay, exercises Copy
and Reply, and compares the gold heading and message-reference quote. Retain
before/after PNGs and JSON, close browser contexts and stop the owned services.
