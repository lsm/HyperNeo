# Web rules

For `packages/web`. The root `AGENTS.md` still applies.

- `check:raw-palette`: use theme tokens, not new raw Tailwind palette classes in `packages/web/src`.
- Use `messages.bySession` snapshots/deltas; re-sync on reconnect or `MESSAGE_TOO_LARGE`.
- Pipelines here follow the Pipelines section of `packages/daemon/AGENTS.md`; read it before writing one.
