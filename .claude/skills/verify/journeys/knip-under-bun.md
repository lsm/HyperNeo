**Knip sees the daemon's ws and undici imports under Bun.** Bun's `node:module`
reports `ws` and `undici` as builtins, and knip skips builtin imports. Under
Bun, knip used to report the daemon's `ws`, `@types/ws` and `undici` as unused.
`bun run` uses Node for knip only when `node` is on PATH. Otherwise Bun stands
in for it, so a host without Node failed `bun run check` while CI stayed green.

Reproduce on a checkout after `bun install`. `--bun` forces Bun's runtime even
when Node is installed:

```bash
bun --bun run knip
```

End state: exit 0, and `ws`, `@types/ws` and `undici` are not listed as unused.
