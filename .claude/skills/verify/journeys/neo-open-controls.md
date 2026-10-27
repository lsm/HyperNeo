# Unified Neo Open controls

Use the resource guard and shared isolated setup from SKILL.md. Build web first.
The helper uses a real daemon with fresh synthetic root/worker sessions and four
source questions, plus linked todos and focused headers. External HTTP is off;
no provider, native app or live daemon is used.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-open-controls.ts after "$READY"
```

Read the ready JSON. In persistent headed Playwright, import verifyOpenControls
from neo-open-controls-web.mjs. Call it with {theme,touch,evidence:'<run>/evidence'}
for light and dark at desktop 1280x900 and touch 390x844. Before the fix, preserve
separate evidence showing one extra header opener and no question-card logo.

QA inventory: the header keeps session context with no duplicate Open session
pill; each question and todo opener contains one harness/app logo and only the
localized word Open. Inspect each supported app (Codex, Claude, Copilot, HyperNeo)
in both themes. A retired focused discussion with no remaining opener must retain
a single card-level logo + Open fallback, outside the header, and reach its session.
The helper records actual rendered colors and contrast against
the question surface, checks todo logo colors agree, and saves each card PNG.
Inspect the screenshots for readable colors and no clipping. Both the local
question Open and todo Open must enter the existing session pane; Back restores
the question and its answer controls. External app callbacks are component-tested;
do not launch a native app to test them.

Explore keyboard activation and repeated Open/Back, then confirm the header is
still absent. Save browser.json with phase after and passed true after all four
theme/viewport cases and visual inspection. Close owned contexts and signal the
helper PID with SIGUSR1. Require wrapper exit zero; it retains evidence and
removes only synthetic HOME/data. Run NeoAskTodos, NeoSessionMark and full check.
Deployment smoke waits for an automatically served containing build, then uses
only the explicitly allowed read-only local browser surface. Never restart.
