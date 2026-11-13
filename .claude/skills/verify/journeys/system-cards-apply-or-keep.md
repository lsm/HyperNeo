# Rule and setting cards apply or keep

The daemon's own rule, pack-setting and home-repository cards are fixed
two-option choices: A applies, B keeps what is there. A yes/no card opened before
the upgrade still applies on yes.

On a fresh isolated daemon from Launch, with `HYPERNEO_DATA_DIR="$RUN/data"`:

```bash
bun .claude/skills/verify/system-cards-apply-or-keep.ts <port> "$RUN"
NODE_PATH=<directory containing playwright> VERIFY_BROWSER=<Chromium executable> \
  node .claude/skills/verify/system-cards-apply-or-keep-web.mjs <port> "$RUN"
```

The first helper drives the real RPC doors. A `neo.rule.ask` card reaches the
snapshot as a choice of `Apply these rule changes` or `Keep current rules`. Keep and
a bare chat `yes` change no rules. A chat `A` and the apply button each apply their
edit. A card turned into a pre-upgrade yes/no card applies on a chat `yes`. A
setting proposal saves nothing on keep, saves on a chat `A`, and a pre-upgrade
yes/no setting card saves on a button `yes`. Evidence:
`evidence/system-cards-apply-or-keep.json`.

The second helper pairs a headless browser, opens `/neo` at 390 wide and finds the
setting card with `Apply these settings` and `Keep current settings` exactly as
written, with no drawn letters and no yes/no buttons. Tapping Apply saves the
setting. Evidence:
`evidence/system-cards-apply-or-keep-web.{json,png}`; look at the screenshot.

The home-repository card is covered by `neo-home-github.ts` in
[the private home proposal journey](private-github-home-proposal-h3-slice-2.md)
with its `verify`, `chat`, `legacy` and `decline` modes. Citing a chat `A` to
`neo.rule.save` needs a Neo session caller, so unit tests cover it, not this RPC
helper. Stop the daemon with `stop.sh` in the same shell as launch.
