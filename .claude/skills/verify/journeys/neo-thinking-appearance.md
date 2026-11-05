# Neo thinking bulb and model pill (#9086 item 5)

Follow SKILL.md's resource guard, web build, isolated HOME/data and cleanup.
The metadata-only fixture owns a real daemon and web asset server. Its GLM
probe and empty model-list responses are synthetic in-process fetch responses;
every other HTTP fetch is refused. It stores only a synthetic dev-proxy key in
the disposable DB. No model turns, live daemon, real keys or external provider
requests are involved. This proves appearance and preference persistence, not
provider inference.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/neo-thinking-bulb.ts after "$READY"
```

Keep the owning shell alive. READY contains the ephemeral URL, run and PID.
In persistent headed Playwright import verifyThinkingAppearance from
neo-thinking-appearance-check.mjs. Pass each page, READY fixture and
{evidence:'<run>/evidence',repo:'<checkout>',bunPath:'<bun executable>',touch:false}.
Use 1280x900 light desktop and 390x844 dark touch, one viewport at a time.
The child RPC helper inherits only VERIFY_PORT, never the parent credentials.

QA inventory: each saved level is selected through the real neo.preferences.set
operation, then the browser reloads and focuses the composer. Require zero pill
border, no separator, no circle/rays, grey Off outline, and bulb glass filled
from its neck by 1/6 through 6/6 in the existing colour ramp. Only Ultra glows.
Compare the seven pill screenshots per viewport visually; SVG geometry alone
is insufficient. The real menu must display the corresponding slider position.
Escape closes it. Reload retains Ultra, then Home in the menu returns to Off
without leaving fill or glow behind. Check the complete composer screenshot
for viewport fit, clipping, button placement and horizontal overflow.

Baseline: the prior real /neo composer has an outlined model pill with a dot,
a circular progress ring and rays. Capture that before the change; preserve
the failing NeoPreferences cases in a signed reproduction commit. The tests
also exercise the full seven-state output in the actual NeoPreferences component.

After visual review, write browser.json with phase after, passed true and both
returned viewport observations. Close contexts/browser and send SIGUSR1 to the
helper PID. Require wrapper exit zero; it saves evidence then removes synthetic
HOME/data. Run NeoPreferences tests, the web build and full repository checks.
After merge, confirm the served build contains the squash and browser-check
those assets live without restarting the daemon. Isolated proof alone leaves
that deployment smoke gate pending.
