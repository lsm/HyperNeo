# In-App Browser & Agent Browser-Use

> **Status:** Exploratory design. Not implemented. This document captures a
> design discussion and a recommended approach; it does not describe shipped
> behaviour.

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
| **2. Playwright + CDP screencast** ✅ SELECTED | Headless Chromium, frames streamed into the UI | ✅ (Chromium is uniform) | High | Medium (mostly wiring) |
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
consistency, defensive sites — is already solved by the CDP layer Playwright
provides. Option 2 adds a frame stream and an input forwarder on top of an
engine HyperNeo already runs, reuses the existing playwright/chrome-devtools-mcp
tooling, and produces a pane that works in the browser **and** Tauri because it
is just a web component over the existing WebSocket transport.

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
│   └─ <BrowserPane>  ── draws JPEG frames to <canvas>                                        │
│        ▲ user mouse/key          │ frames                                                    │
│        │                          ▼                                                           │
│        │       MessageHub WebSocket (existing transport)                                      │
│        │                          ▲                                                           │
│        │          ┌───────────────┴────────────────┐                                          │
│        │          │  daemon: BrowserEngineService   │                                          │
│        │          │   • holds Playwright + CDP sesn │                                          │
│        │          │   • screencast loop             │                                          │
│        │          │   • input router                │                                          │
│        │          │   • agent action primitives     │                                          │
│        │          └───────────────┬────────────────┘                                          │
│        │                          │ CDP                                                        │
│        │                          ▼                                                            │
│        │          ┌─────────────────────────────────┐                                         │
│        └─────────▶│  headless Chromium (Playwright) │  ← real rendering, trusted input         │
│                   └─────────────────────────────────┘                                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

There are **two distinct webviews** to keep separate in the mental model: the
*app UI* (Preact, rendered by the OS webview) and the *depicted browser*
(headless Chromium, shown as pixels on a canvas). One renders an image of the
other; they are not the same thing.

### Component map (proposed; not yet implemented)

| Piece | Proposed location | Notes |
|---|---|---|
| Headless Chromium + Playwright | daemon process | Reuses the playwright skill's Chromium; run headless |
| CDP broker (screencast + input + agent actions) | `packages/daemon/src/lib/browser/` (`BrowserEngineService`) | Holds `newCDPSession(page)`, runs the frame loop, forwards input |
| Transport | MessageHub WS — new channels `browser.frame` (pub), `browser.input` / `browser.action` (RPC) | Mirrors how `messages.bySession` already streams |
| Renderer | Preact `<BrowserPane>` in `packages/web` | `<canvas>` + input capture |
| Tauri shell | `packages/desktop` — **unchanged** | No Rust changes; the pane is just another web component |

The crucial line: **the Tauri Rust shell changes nothing.** No new Rust, no
webview reparenting, no platform-specific glue.

### Data flow: watch the agent browse

The agent calls an MCP tool (navigate/click/type) → daemon → Playwright acts.
Simultaneously a screencast is always running:

```ts
// one-time, on browser-session start (raw CDP via Playwright)
const cdp = await page.context().newCDPSession(page);
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 70,
  maxWidth: 1280,
  maxHeight: 800,
});

cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  hub.publish('browser.frame', { jpeg: data, metadata }); // → <BrowserPane> canvas
  cdp.send('Page.screencastFrameAck', { sessionId });      // must ack to get next frame
});
```

Frames flow daemon → WS → canvas at roughly 10–30 fps depending on quality/size.
Stop with `Page.stopScreencast`.

### Data flow: human drives (or takes over)

The user clicks the pane at canvas pixel `(cx, cy)`; the component converts to
CSS page coords and forwards through **Playwright's high-level API**, which
handles devicePixelRatio and produces trusted events:

```ts
// forward via Playwright — it does the coordinate + trusted-event math for you
const cssX = cx * (pageViewportWidth  / canvasDisplayWidth);
const cssY = cy * (pageViewportHeight / canvasDisplayHeight);
await page.mouse.click(cssX, cssY);
await page.keyboard.type(text);
```

Key simplification: **screencast needs raw CDP, but input does not.** Route
human/agent input through `page.mouse` / `page.keyboard` and Playwright handles
coordinates + trusted-event dispatch correctly. Only touch `Input.dispatch*`
directly if bypassing Playwright.

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
   recording by design**.

3. **The agent can read the authenticated session.** The same headless Chromium
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
| Ships Chromium | Playwright's Chromium is a lazy first-use download (same one the playwright skill already fetches). Base app stays on the OS webview; only browser-use sessions pull it. |
| Two webviews | App UI (OS webview) vs. depicted browser (Chromium as pixels). Keep them distinct. |
| Input ownership | Decide arbitration: when the agent is mid-action and the user clicks, does it queue or interrupt? Make human input able to pause/override; don't leave it implicit. |
| Sandboxing | The Chromium executes agent-influenced code on arbitrary sites. Sandbox it: separate context/profile, no shared credentials with the host app, ideally network/FS restrictions. |

## Proposed Implementation Surface

All proposed, none present today:

| File / area | Change |
|---|---|
| `packages/daemon/src/lib/browser/` (new) | `BrowserEngineService` — launches headless Chromium, holds CDP session, runs screencast loop, forwards input, exposes agent action primitives |
| MessageHub channels (new) | `browser.frame` (pub/sub frame stream), `browser.input` (human input), `browser.action` (agent tool calls) |
| `packages/web` (new component) | Preact `<BrowserPane>` — subscribes to frame stream, renders to `<canvas>`, captures + forwards user input |
| `packages/skills` (existing) | `playwright` / `playwright-interactive` / `chrome-devtools-mcp` — engine reused, surfaced through the new pane |
| `packages/desktop` (existing) | **No changes** — pane is a web component |

### Suggested spike (validation slice)

Before wiring into the real UI, validate the latency and coordinate-math feel
with a minimal slice that needs no Tauri:

1. A daemon service that launches headless Chromium and runs the screencast loop.
2. A standalone HTML page (`<BrowserPane>` prototype, no Tauri) that renders the
   frame stream and forwards clicks.

Enough to confirm the fps/coordinate feel, then wire into the real UI and the
desktop shell.

## Open Questions

- **Input arbitration semantics** — queue vs. interrupt when human and agent both act.
- **Recording exclusion mechanism** — how sensitive-page frames and keystrokes are identified and excluded from rewind/persistence.
- **Credential policy** — whether the agent may read authenticated sessions at all, or only for an explicit allowlist of origins.
- **Chromium lifecycle** — whether the headless Chromium is spawned/managed by the daemon or, optionally, by the Tauri shell.
