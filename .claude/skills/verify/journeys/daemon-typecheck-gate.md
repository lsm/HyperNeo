# Standard daemon compiler gate

The user surface is the shared quality command. No daemon, browser, provider or
credentials are needed. Use the shared pinned Bun and resource preflight.

```bash
bun run test:typecheck
bun run typecheck
```

The command contracts execute the actual package scripts in disposable compiler
fixtures. Success must invoke the workspace compiler and the standard daemon
compiler. A daemon-only rejection must return exit two; a workspace rejection
must stop before the daemon compiler. The fixtures are removed after each case.

The real command must then run both installed compilers against this checkout
and exit zero. Retain both outputs. CI's lint/type-check job and pre-commit use
this shared command, so a standard daemon compiler rejection blocks both.

For the original Calendar regression, TypeScript 6.0.3 rejected a single map
receiving calendar/event callbacks with different result shapes (TS2345), while
TypeScript 7.0.2 accepted it. Separate the branch projections before expecting
the real shared command to pass; passing only the workspace compiler is not
proof that the daemon compiler accepts the source.
