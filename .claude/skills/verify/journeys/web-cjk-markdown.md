# CJK emphasis in previews and chat

Use shared build, isolated environment, launch, doctor and stop instructions in
../SKILL.md. No provider or model turn is needed. Never use the live daemon.

Before launch, seed a fresh run (with its home directory already created):

```bash
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  bun .claude/skills/verify/cjk-markdown-seed.ts "$RUN"
```

This delegates synthetic DB creation to preview-register.ts, gives its worker a
valid UUID for the session route, then saves the same synthetic Markdown as an
assistant message and workspace report. It never copies real data.

After launch and a usable doctor result, run in the same owning shell:

```bash
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<Chrome executable> \
  node .claude/skills/verify/cjk-markdown-web.mjs "$RUN" "$PORT" after "$EVIDENCE"
```

Use installed Chrome if a cached Chromium has missing framework files. The helper
blocks off-origin requests, registers the file via artifact.file.register, and
visits its artifact preview and the worker chat at 1280 and 390 pixels. It asserts
exact bold and italic text, no bold spill into ordinary text, literal code and
escaped stars, single-dollar currency, table cells and a hard break. Inspect all
four screenshots. JSON records the observed text and emphasis. Before the fix,
run with `before` to require the regression and capture matching evidence.
Stop only the owned run. Component tests in MarkdownRenderer.cjk.test.tsx also
cover Korean, triple delimiters, ordinary GFM, ASCII flanking and double-dollar
math. iOS and real model generation are outside this proof.
