# In-App Browser & Agent Browser-Use

> **Status:** Exploratory design. Not implemented. This document captures a
> design discussion and a recommended approach; it does not describe shipped
> behaviour. Revised after automated review (Codex) to surface prerequisites
> that the first draft understated — see [Open Questions](#open-questions).

## Goal

Render the browser that an agent drives **inside the HyperNeo app UI**, so a
human can watch the agent browse in real time and optionally take over
(clicking, typing, logging in) through the same pane. Reuse HyperNeo's existing
Playwright tooling as the automation engine rather than reinventing a protocol
layer. The pane must work both in the web UI and in the Tauri desktop shell.

## Context

HyperNeo already ships browser automation as MCP skills (`playwright`,
`playwright-interactive`) and `chrome-devtools-mcp`, driven by the Claude Agent
SDK. Today those skills launch a browser that opens as a **separate OS window**
the user watches. That works, but the browser lives outside the app: it can't be
embedded in the session UI, the user can't take over cleanly, and the experience
doesn't carry to the Tauri shell as a first-class pane.

This document evaluates how to collapse that external browser into an in-app
pane without sacrificing robustness.

### Key fact: how Playwright actually works

A common misconception is that "Playwright just injects scripts into pages, so
it doesn't need a control protocol." That is half right. Playwright for Chromium
**is a Chrome DevTools Protocol (CDP) client** — it connects to the browser over
CDP, and that connection is the control channel. It *also* injects a large JS
payload into every page (selector engines for `text`/`role`/`css`/`xpath`,
actionability checks, the `__playwright__` harness) via
`Page.addScriptToEvaluateOnNewDocument`, but that injection **rides on top of**
CDP. CDP is load-bearing for everything injection cannot do: trusted input
events, screenshots, isolated contexts, target/tab management. (Firefox/WebKit
backends use a custom protocol — Juggler / WebKit's — plus the same injection;
still a protocol underneath, not pure injection.)

This distinction decides which option below is viable.

## Options Considered

| Option | Engine | Cross-platform | Robustness | New code |
|--------|--------|----------------|------------|----------|
| **1. Lite injection harness** | Tauri OS webview + `initialization_script`, no CDP | ✅ all OS webviews | Low–medium (hits injection ceiling) | Medium |
| **2. Playwright + CDP screencast** ✅ SELECTED | Headless Chromium, frames streamed into the UI | ✅ (Chromium is uniform) | High | Medium–high (see bridge prerequisite) |
| **3. Full CDP on embedded browser** | CEF / `deno desktop` CEF backend | Partial | High | High + depends on unexposed CDP |

### Option 1 — Lite injection harness (no CDP)

Open a separate Tauri webview for browsing, inject a control script via
`WebviewBuilder::initialization_script` (runs before page scripts on **every**
navigation, surviving cross-origin navigations), expose `invoke` so the injected
script reports the DOM/accessibility tree back to Rust, and use Rust window
capture for screenshots.

What pure injection can do: read the DOM/AX tree, `element.click()` buttons,
fill forms, navigate, scrape content. What it **cannot** do:

| Capability | Needs CDP? | JS injection alone |
|---|---|---|
| Read DOM / accessibility tree | No | ✅ |
| Click buttons, fill forms, navigate | No (mostly) | ✅ |
| **Trusted** mouse at x,y / real key events | **Yes** (`Input.dispatchMouseEvent`) | ❌ injected events are `isTrusted=false` |
| **Screenshot** for a vision model | **Yes** (`Page.captureScreenshot`) | ❌ in-page JS can't capture cross-origin |
| Multi-tab / isolated contexts / downloads | **Yes** (`Target.*`) | ❌ |

The ceiling is real: `isTrusted=false` events are ignored by security-sensitive
controls, canvas/pointer apps, and some SPAs; in-page JS cannot screenshot a
cross-origin page; a single page cannot manage tabs or downloads.

| Pros | Cons |
|------|------|
| No external browser dependency | Hits the `isTrusted` / screenshot / multi-context ceiling |
| Cross-platform via OS webviews | Cannot do vision-driven computer-use |
| Smallest footprint | Not faithful browser-use for defensive/arbitrary sites |

### Option 2 — Playwright (CDP) engine + screencast ✅ SELECTED

Keep a real Chromium driven by Playwright over CDP (robust, trusted input, real
screenshots, multi-context) and stream its pixels into a normal web component in
the UI. See [Selected Approach](#selected-approach-cdp-screencast) below.

### Option 3 — Full CDP on an embedded browser (CEF / `deno desktop`)

Bundle a Chromium directly (CEF, or the CEF backend of `deno desktop`) and drive
it via CDP. Feasible in principle — CEF is Chromium and supports
`--remote-debugging-port` — **but** the documented `deno desktop` CEF API does
not expose CDP, a remote-debugging port, or programmatic CDP access (only
`bindings.<name>()` and `executeJs`). So a faithful browser-use on that surface
is gated on Deno Desktop adding a CDP API. Bundling CEF separately also largely
defeats the small-binary rationale of Tauri's OS webview.

| Pros | Cons |
|------|------|
| Consistent rendering (full Chromium) | `deno desktop` CEF doesn't expose CDP today |
| No separate browser process | ~150 MB framework; heavy |
| | Non-portable unless you bundle Chromium everywhere |

### Why Option 2

Every hard problem — trusted input, screenshots, multi-context, cross-platform
consistency, defensive sites — is solved by the CDP layer Playwright provides.
Option 2 adds a frame stream and an input forwarder on top of that engine, and
produces a pane that works in the browser **and** Tauri because it is just a web
component over the existing WebSocket transport.

> **Caveat the first draft missed:** the pane must show the *same* browser the
> agent is driving. HyperNeo's existing browser skills each own isolated
> browsers and do not expose their `Page`/CDP to the daemon, so "reuse" is not
> automatic — it requires a [shared-browser bridge](#shared-browser-bridge),
> which is the central prerequisite of this design.

## Selected Approach: CDP Screencast

### Mental model

"Render the browser in Tauri" sounds like Tauri does something special. It
doesn't. The mechanism is:

> Playwright drives a **headless** Chromium over CDP. Chromium streams its
> pixels back over CDP. Those pixels ride the existing MessageHub WebSocket to a
> `<canvas>` in the web UI. **Tauri is incidental** — it only hosts the web UI.

The pane is therefore a web component that works in a browser with zero Tauri
involvement; "in Tauri" just means it shows up inside the desktop window for
free.

### Architecture

```
┌──────────────────────── HyperNeo app window (Tauri shell, unchanged) ─────────────────────┐
│  Preact UI (OS webview)                                                                     │
│   └─ <BrowserPane sessionId=…>  ── draws JPEG frames to <canvas>                            │
│        ▲ user mouse/key            │ frames (per-session channel)                            │
│        │                            ▼                                                        │
│        │       MessageHub WebSocket (existing transport)                                      │
│        │                            ▲                                                        │
│        │          ┌──────────────────┴───────────────┐                                       │
│        │          │  daemon: BrowserEngineService      │                                       │
│        │          │   • owns the ONE shared Chromium   │                                       │
│        │          │   • per-page CDP session + screencast │                                   │
│        │          │   • backpressure-gated frame loop  │                                       │
│        │          │   • input router (per active page) │                                       │
│        │          │   • agent action primitives (MCP)  │                                       │
│        │          └──────────────────┬───────────────┘                                       │
│        │                           │ CDP                                                       │
│        │                           ▼                                                           │
│        │          ┌──────────────────────────────────┐                                        │
│        └─────────▶│  shared headless Chromium         │ ← the agent's tools ALSO drive this    │
│                   └──────────────────────────────────┘   (via the bridge, not a second one)   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

There are **two distinct webviews** to keep separate in the mental model: the
*app UI* (Preact, rendered by the OS webview) and the *depicted browser*
(headless Chromium, shown as pixels on a canvas). One renders an image of the
other; they are not the same thing.

### Shared browser bridge

The single most important prerequisite, which the first draft understated:
**the pane must depict the browser the agent is actually driving — not a second,
unrelated browser.** Today each browser tool owns an isolated browser it does
not expose:

- `playwright` launches `playwright-cli` via `npx` in its own process.
- `playwright-interactive` creates browser handles inside a `js_repl` session.
- `chrome-devtools-mcp` owns an isolated MCP-managed browser.

A `BrowserEngineService` that independently launched Chromium would render a
page the agent never touches; pane input would target the wrong page; the human
would "take over" a browser the agent isn't using. Two viable bridges resolve
this — pick one (see [Open Questions](#open-questions)):

1. **Service-owned single browser (replace).** `BrowserEngineService` owns the
   one Chromium. The agent's browser actions are reimplemented as MCP tools
   backed by the service (navigate/click/type/screenshot/AX-tree), replacing the
   three existing skills for sessions that want an in-app pane. The service
   exposes the `Page`/CDP to both the agent tools and the screencast loop, so
   there is exactly one browser. Cleanest model; most new code.
2. **Tool-owned, service attaches (bridge).** One existing tool (most naturally
   `chrome-devtools-mcp`, which is already CDP-native) exposes its CDP
   debugging endpoint. `BrowserEngineService` connects to that endpoint over CDP
   (`browserType.connectOverCDP`) and runs the screencast/input loop against the
   tool's pages. Least new code; couples the service to the tool's lifecycle and
   requires the tool to publish its CDP endpoint.

Either way, the invariant is: **one Chromium per browser session, shared by the
agent's actions and the pane.** The component map below assumes the
service-owned model unless noted.

### Component map (proposed; not yet implemented)

| Piece | Proposed location | Notes |
|---|---|---|
| Shared headless Chromium + Playwright | daemon process (`BrowserEngineService`) | One browser per session, driven by both agent tools and the pane (see bridge above) |
| CDP broker (screencast + input + agent actions) | `packages/daemon/src/lib/browser/` | Holds `newCDPSession(page)` **per page**, runs the backpressure-gated frame loop, routes input to the active page |
| Transport | MessageHub WS — **per-session channels** `browser.frame:<sessionId>` (pub), `browser.input:<sessionId>` / `browser.action:<sessionId>` (RPC) | Pane must join the specific session channel; frames are never broadcast across sessions (prevents leaking another session's authenticated pixels) |
| Renderer | Preact `<BrowserPane sessionId>` in `packages/web` | Joins the session channel, renders to `<canvas>`, captures + forwards user input |
| Tauri shell | `packages/desktop` — **unchanged** | No Rust changes; the pane is just another web component |

The crucial line: **the Tauri Rust shell changes nothing.** No new Rust, no
webview reparenting, no platform-specific glue.

### Data flow: watch the agent browse

The agent calls an MCP tool (navigate/click/type) → daemon → Playwright acts on
the shared browser. Simultaneously a screencast is running for the **active
page**:

```ts
// per page, on activation (raw CDP via Playwright)
const cdp = await page.context().newCDPSession(page);
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 70,
  maxWidth: 1280,
  maxHeight: 800,
});

let clientInFlight = false;          // backpressure: at most one frame un-acked by the client
let newestPending: Frame | null = null;

cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  newestPending = { jpeg: data, metadata };          // drop stale intermediates; keep newest only
  if (!clientInFlight) dispatchToClient(sessionId);  // send only when the client is ready
});

function dispatchToClient(cdpSessionId: string) {
  if (!newestPending) return;
  clientInFlight = true;
  const frame = newestPending;
  newestPending = null;
  hub.publish(`browser.frame:${sessionId}`, frame, { onConsumed: () => {
    clientInFlight = false;
    cdp.send('Page.screencastFrameAck', { sessionId: cdpSessionId }); // ack CDP AFTER the client consumed
    if (newestPending) dispatchToClient(cdpSessionId);                // drain the newest pending
  }});
}
```

Frames flow daemon → WS → canvas at roughly 10–30 fps depending on quality/size.
Stop with `Page.stopScreencast`.

#### Backpressure (required)

`Page.screencastFrameAck` is CDP's **only** flow-control point — acknowledging
every frame immediately makes Chromium produce JPEGs as fast as it can, piling
them onto the same WebSocket that carries chat and input RPCs. The loop above
keeps **at most one frame in flight to the client** (dropping stale
intermediates) and **acks CDP only after the client reports consumption**, not
on enqueue. Without this, a slow client/network causes stale video, delayed
takeover input, and unbounded memory growth.

### Data flow: human drives (or takes over)

The user clicks the pane at canvas pixel `(cx, cy)`. Coordinates are mapped from
the **decoded frame dimensions and `screencastFrame` metadata** (not a naive
viewport ratio — that breaks under letterboxing, page zoom, or mobile
emulation), then forwarded through **Playwright's input API** so events are
trusted:

```ts
// metadata carries: pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY
// frame decoded to frameW×frameH; drawn at displayW×displayH inside the canvas with letterbox (offX, offY)
const fx = cx - offX, fy = cy - offY;                                  // 1. remove letterbox
const cssX = (fx / displayW) * metadata.deviceWidth  / metadata.pageScaleFactor + metadata.scrollOffsetX;
const cssY = (fy / displayH) * metadata.deviceHeight / metadata.pageScaleFactor + metadata.scrollOffsetY;
await page.mouse.click(cssX, cssY);                                    // trusted event
```

Playwright dispatches exactly the coordinates it receives — it does **not**
correct the UI→frame transform — so the mapping must be derived from the frame
metadata before calling it.

#### Keyboard event protocol (required)

`page.keyboard.type(text)` only inserts a text string; it cannot reproduce
Tab, Enter, Escape, Backspace, arrow keys, modifier shortcuts, held modifiers,
or IME composition — all common during login and form navigation. Human input
must use a real keyboard event protocol, not completed text:

| Client event | Playwright call |
|---|---|
| `keydown` / `keyup` with `key`, `code`, `modifiers` | `page.keyboard.down(key)` / `page.keyboard.up(key)` |
| Named-key press (Enter, Tab, Escape, arrows, shortcuts) | `page.keyboard.press('Enter' \| 'Tab' \| …)` |
| Text / IME composition | `page.keyboard.type(text)` or CDP `Input.insertText` for composition |

The client sends `keydown`/`keyup`/`text` events with modifiers; the broker
maps them to the Playwright calls above. Focus management (which element
receives input) follows the active page's focused element.

### Tab/page lifecycle (required)

`newCDPSession(page)` is bound to **one** target; it does not follow tab
switches, popups, or `target="_blank"` navigations. For multi-tab to work (which
the design cites as a reason for choosing this approach), the broker must:

- Open a CDP session **per page** (`Target.attachedToTarget` / Playwright's
  page-collection events).
- Start a screencast only for the **active** page; stop or suppress inactive
  streams (otherwise every tab encodes frames).
- On activation change, **atomically** switch both rendering (which frame stream
  the pane subscribes to) and input routing (which `page` receives
  mouse/keyboard) so video and takeover never target different tabs.

### Agent observation (what the model sees)

Reuse the same CDP session for the model's view of the page:

- **Vision path** (à la computer-use): `cdp.send('Page.captureScreenshot')`.
- **Text/structure path** (à la browser-use): `cdp.send('Accessibility.getFullAXTree')`, or a DOM simplification over `DOM.getDocument`.

Same connection, different consumer. The model may receive screenshot, AX tree,
or both.

## Security Constraints (credentials, recording, agent access)

Because a human can log into sites through this pane, credentials now flow
through and become accessible to the app's stack in ways a standalone browser
does not. These must be handled by design, not by accident:

1. **Credentials transit the app stack.** Keystrokes flow pane → WS → daemon →
   CDP → Chromium. The daemon process (and anything reading the WS) is inside
   the credential trust boundary. This is a real expansion vs. a normal browser,
   where keystrokes stay inside the browser process.

2. **Recording / rewind is the dangerous one.** HyperNeo persists messages and
   has rewind/checkpoints. If screencast frames or input events are wired into
   that persistence naively, **passwords can be captured to disk** — as
   typed-input logs, or as frame pixels (especially if anyone toggles "show
   password"). Sensitive-page frames and keystrokes must be **excluded from
   recording by design**. The per-session channel routing also matters here:
   frames must never be broadcast across sessions, or one session's pane could
   render another session's authenticated pixels.

3. **The agent can read the authenticated session.** The same shared Chromium
   the human types into is *also* drivable by the agent over the same CDP
   session. The moment a human logs in, the agent (and any code with CDP access)
   can run
   `page.evaluate(() => document.querySelector('input[type=password]').value)`,
   read cookies via `page.context().cookies()`, read `localStorage`, or
   screenshot the page. A normal browser walls the page off from the app; this
   architecture **deliberately bridges them**. For a personal single-user tool
   that is often the intent (the agent should reuse the human's session), but it
   must be a conscious decision — there is no isolation between "what the human
   typed" and "what the agent can see."

4. **Isolate the Chromium.** Use a dedicated Playwright browser context/profile.
   Do not share cookies or credentials with the host app or the user's main
   browser profile unless intended.

5. **No OS-keychain autofill by default.** A headless Chromium has no system
   keychain and an empty profile, so password managers will not fill. The human
   types the password, and it then lives in the Chromium's cookies/profile until
   cleared.

## Tradeoffs

| Aspect | Notes |
|---|---|
| Latency | Screencast is watchable but not instant — a frame or two of round-trip. Fine for watching an agent; not a daily-driver browser. Tunable via quality/maxWidth. |
| Ships Chromium | **Not free in release builds.** Playwright is currently only a CLI *dev* dependency, and the interactive skill requires manually installing both the package and the browser executable — so a compiled daemon sidecar has neither on a clean user machine. Landing this requires a real packaging strategy (see below), not lazy first-use download. |
| Two webviews | App UI (OS webview) vs. depicted browser (Chromium as pixels). Keep them distinct. |
| Input ownership | Decide arbitration: when the agent is mid-action and the user clicks, does it queue or interrupt? Make human input able to pause/override; don't leave it implicit. |
| Sandboxing | The Chromium executes agent-influenced code on arbitrary sites. Sandbox it: separate context/profile, no shared credentials with the host app, ideally network/FS restrictions. |

### Chromium packaging for release builds

Because Playwright is a dev-only dependency today, a packaged desktop install
will **not** obtain Chromium by lazy download on first launch. The
implementation must define one of:

- **Bundle** Playwright's Chromium into the desktop release artifact (adds ~150 MB
  to the installer; offline-friendly; pinned version).
- **First-run installer** that downloads Playwright + the browser binary on
  first use, with progress UI, retry/checksum verification, and a defined
  failure path (degraded mode that disables browser-use but keeps the app
  usable).

Either choice belongs in the implementation surface before this feature ships.

## Proposed Implementation Surface

All proposed, none present today:

| File / area | Change |
|---|---|
| `packages/daemon/src/lib/browser/` (new) | `BrowserEngineService` — owns the shared Chromium, holds per-page CDP sessions, runs the backpressure-gated screencast loop, routes input to the active page, exposes agent action primitives (MCP) |
| Existing browser skills (`playwright`, `playwright-interactive`, `chrome-devtools-mcp`) | Either reimplemented on the service, or (bridge option) `chrome-devtools-mcp` exposes its CDP endpoint for the service to attach — see [Shared browser bridge](#shared-browser-bridge) |
| MessageHub channels (new, per-session) | `browser.frame:<sessionId>` (pub/sub frame stream, backpressure-gated), `browser.input:<sessionId>` (human input), `browser.action:<sessionId>` (agent tool calls) |
| `packages/web` (new component) | Preact `<BrowserPane sessionId>` — joins the session channel, renders to `<canvas>`, maps pointer coords from frame metadata, forwards the keyboard event protocol |
| `packages/desktop` (existing) | **No changes** — pane is a web component |
| Release packaging | Bundle or first-run-install Playwright + Chromium (see above) |

### Suggested spike (validation slice)

Before wiring into the real UI, validate the latency, coordinate-math, and
backpressure feel with a minimal slice that needs no Tauri and assumes the
service-owned bridge:

1. A daemon service that launches one headless Chromium, owns a per-page CDP
   session, and runs the backpressure-gated screencast loop.
2. The agent's actions exposed as MCP tools against that same Chromium.
3. A standalone HTML page (`<BrowserPane>` prototype, no Tauri) that joins the
   session channel, renders the frame stream, maps clicks from frame metadata,
   and forwards the keyboard event protocol.

Enough to confirm the fps/coordinate/backpressure feel, then wire into the real
UI and the desktop shell.

## Open Questions

The review surfaced several prerequisites the first draft treated as solved.
Resolved in this revision (specified, not yet implemented):

- **Shared-browser bridge** — pane must depict the agent's browser; choose
  service-owned (replace) vs. tool-owned (attach to `chrome-devtools-mcp`'s CDP).
- **Per-session frame channels** — frames routed only to the joined session.
- **Screencast backpressure** — at most one frame in flight; ack CDP after
  client consumption.
- **Tab/page lifecycle** — per-page CDP sessions; atomic switch of render +
  input on activation change.
- **Keyboard event protocol** — keydown/keyup/press/text/composition, not just
  `type(text)`.
- **Pointer mapping from frame metadata** — not a naive viewport ratio.
- **Chromium packaging for release** — bundle vs. first-run installer.

Still open:

- **Bridge choice** — service-owned (replace) vs. tool-owned (attach). The
  central decision; affects how much of the existing skill code is rewritten.
- **Input arbitration semantics** — queue vs. interrupt when human and agent both act.
- **Recording exclusion mechanism** — how sensitive-page frames and keystrokes are identified and excluded from rewind/persistence.
- **Credential policy** — whether the agent may read authenticated sessions at all, or only for an explicit allowlist of origins.
- **Chromium lifecycle** — whether the shared Chromium is spawned/managed by the daemon or, optionally, by the Tauri shell.
