# Prompt rules

For `packages/prompts`. The root `AGENTS.md` still applies.

- In `packages/prompts/src/mod.ts`, import every `.md` with `with { type: 'text' }`; Bun otherwise renders HTML.
- SDK runtime locations come from the host system prompt, not workflow slot prompts.
- Workflow slot prompts describe behavior; do not duplicate peers, channels, gate IDs or reviewer framing.
