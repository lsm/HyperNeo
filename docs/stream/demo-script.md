# NeoKai Live UI Demo Script

A bounded, 8–10 minute walkthrough of NeoKai using the `dev-NeoKai` Space. All actions are read-only or easily reversible.

## Prerequisites

```bash
# Terminal 1 — start the dev server on port 8383 with an isolated DB.
# If you will press Enter in the chat input, enable the dev proxy env:
NEOKAI_USE_DEV_PROXY=1 make dev DB_PATH=/tmp/beokai-8383 PORT=8383

# Terminal 2 — start the dev proxy whenever NEOKAI_USE_DEV_PROXY=1 is set above.
# The daemon routes Anthropic calls to 127.0.0.1:8000; devproxy must be listening there.
make test-proxy-start
```

Open the app at `http://localhost:8383` in the browser source used by OBS.

A fresh isolated DB has no Spaces. Before the stream, run the dry-run script once to create the `dev-NeoKai` demo Space:

```bash
cd packages/e2e && bun run scripts/demo-stream-dry-run.ts
```

The script is safe to re-run: it reuses an existing `dev-NeoKai` Space, reuses an existing demo task, and deletes only the session it created. By default the Space is kept so the live demo can open it; set `DEMO_CLEANUP_SPACE=1` to also delete the Space after the run.

## Demo flow

### 1. Opening — Spaces list (0:00–0:45)

**Narrative:** “NeoKai is a browser UI for the Claude Agent SDK. Everything starts in Spaces. A Space is a persistent project room where agents, tasks, sessions, and evidence live together.”

**UI action:** Start on `/spaces`.

**Expected state:** Space switcher visible; `Create Space` button at the bottom.

**Safety:** Do not click `Create Space` during the live demo.

### 2. Enter the dev-NeoKai Space (0:45–1:30)

**UI action:** Click the `dev-NeoKai` space in the left sidebar.

**Expected state:** URL becomes `/space/dev-neokai` (or slug). Space navigation renders: Overview, Agents, Goals, Forge, Tasks, Sessions.

**Talking points:**
- This Space is dogfooding NeoKai itself.
- The sidebar shows live task counts and session counts.

### 3. Overview & task context (1:30–3:00)

**UI action:** Stay on Overview. If tasks exist, click one task from the sidebar under `Tasks` → `Action`/`Active`.

**Expected state:** Task detail opens on the right. Tabs: Thread, Timeline, Log, Canvas, Artifacts.

**Talking points:**
- A task is the unit of work. It carries its own thread, status, and artifacts.
- Tabs show how agents communicate (Thread), what happened (Timeline), and files produced (Artifacts).

**Safety:** Only open existing tasks. Do not change status or create runs.

### 4. Agents & workflows (3:00–4:00)

**UI action:** Click `Agents` in the space sidebar.

**Expected state:** Long-horizon agent list visible with at least `Coordinator`. Each agent shows autonomy level, model, and instructions.

**Talking points:**
- Spaces seed a Coordinator agent automatically.
- Agents are peers in a workflow; the workflow graph decides handoffs.

**Safety:** Do not edit agents or save prompt changes.

### 5. Forge evidence (4:00–4:45)

**UI action:** Click `Forge` in the space sidebar.

**Expected state:** Forge panel lists evidence, learnings, or metrics captured from past runs.

**Talking points:**
- Forge is the long-horizon memory of the Space.
- Evidence from one task can inform the next planning cycle.

### 6. Live session demo (4:45–6:30)

**UI action:** Click `Sessions` in the space sidebar, then click `Create session` (plus icon in the Sessions section).

**Expected state:** A new chat opens on the right. The input placeholder reads `Ask or make anything...`.

**UI action:** Type a harmless prompt (do **not** press Enter unless dev proxy is running):

```text
Hi NeoKai — can you summarize what this Space is working on?
```

**Talking points:**
- Sessions are real-time agent chats.
- The same session framework powers both quick human chats and autonomous workflow steps.

**Safety:** If no proxy is running, stop after typing the prompt and explain that you would press Enter next.

### 7. Settings & skills (6:30–7:30)

**UI action:** Click `Settings` in the bottom-left of the sidebar, then `Skills`.

**Expected state:** Skills tab lists available slash commands and MCP servers.

**Talking points:**
- Skills are configured globally and can be disabled per Space.
- MCP servers extend NeoKai with external tools like browsers and databases.

**Safety:** Do not toggle skills on/off; keep the view read-only.

### 8. Close (7:30–8:00)

**UI action:** Return to `/spaces` using the back arrow or the `Spaces` section switcher.

**Narrative:** “That’s NeoKai — Spaces, agents, tasks, and live sessions in one multi-agent desktop. Thanks for watching.”

**Expected state:** Viewer sees the spaces list as the stream ends.

## Abort conditions

Switch to the `BRB / Fail-Safe` OBS scene if any of the following happen:

- A credential, token, or personal path appears.
- A destructive confirmation dialog appears.
- The WebSocket disconnects and reconnects with stale or broken state.
- The UI throws a visible error boundary.
- Any unscripted action is requested in chat.

## Selectors used by the dry-run script

- Space switcher: `[data-testid="space-switcher"]`
- Space nav items: `[data-testid="space-detail-dashboard"]` etc.
- Tasks view: `[data-testid="space-tasks-view"]`
- Chat input: `textarea[placeholder="Ask or make anything..."]`
- Settings button: `aria-label=/Settings/i`
- Skills content: `role=button name="Add Skill"`
