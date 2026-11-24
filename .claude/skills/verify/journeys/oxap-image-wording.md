# Image guidance in an OXAP Codex chat

Use the isolated setup and pinned Bun in [Verify](../SKILL.md). Build the web
bundle and supply the verified release binary as in the
[OXAP settings journey](oxap-hub-settings.md). Set `NODE_PATH` and
`VERIFY_BROWSER` for Playwright.

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 image-wording
```

The browser opens an OXAP Codex chat in desktop and touch phone viewports.
The composer starts without a permanent warning. Selecting **Attach image**
shows the client, model and what to use for images. It opens no file picker.
Pasting and dropping an image on desktop show the same guidance. Compare the
idle and attachment screenshots. On desktop, open the OXAP provider settings
and save the client. Confirm the installation and save labels. This journey
sends zero turns to Codex.
