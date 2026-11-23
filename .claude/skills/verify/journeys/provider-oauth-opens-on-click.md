# Provider OAuth opens the consent page only on the user's click

Use **Launch** in ../SKILL.md. Build packages/web for HEAD first, then:

```sh
NODE_PATH=<directory containing playwright> \
  .claude/skills/verify/provider-oauth-popup.sh "$EVIDENCE" expect-click
```

The helper owns a fresh isolated daemon and pairs a headless browser. It opens
Settings → Providers → Add Provider and clicks Connect on OpenAI Codex. The
daemon builds the consent URL locally; the browser stubs `auth.openai.com`, so
nothing leaves the machine and no account is used.

It wraps `window.open` to record each call and whether the page still had user
activation. `expect-click` requires no open while the modal waits, then exactly
one open with user activation when the user clicks Open Auth URL, and modal copy
that does not point at an already opened tab. `expect-auto` records the old
behavior for a before screenshot: one open right after the awaited login RPC.

Inspect `provider-oauth-<mode>-modal.png` and `provider-oauth-<mode>.json`.
