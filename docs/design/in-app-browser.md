# In-App Browser & Agent Browser-Use

> **Status:** Exploratory design. Not implemented. This document captures a
> design discussion and a recommended approach; it does not describe shipped
> behaviour. Revised three times after automated review (Codex). Round 2 checked
> the design against HyperNeo's actual source (MessageHub transport,
> `chrome-devtools-mcp` lifecycle, the Playwright dependency, the desktop bundle)
> and corrected API-level inaccuracies; round 3 tightened the screencast ack
> invariant, activation/epoch handling, log redaction, and pointer modifiers. See
> [Open Questions](#open-questions).

## Goal

Render the browser that an agent drives **inside the HyperNeo app UI**, so a
human can watch the agent browse in real time and optionally take over
(clicking, typing, logging in) through the same pane. Reuse a CDP-driven
Chromium as the automation engine rather than reinventing a protocol layer. The
pane must work both in the web UI and in the Tauri desktop shell.

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
| **2. Playwright + CDP screencast** ✅ SELECTED | Headless Chromium, frames streamed into the UI | ✅ (Chromium is uniform) | High | High (see prerequisites) |
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

> The pane must show the *same* browser the agent is driving, and that browser
> must live for the whole HyperNeo session — not one agent query. Those two
> constraints drive the [shared-browser bridge](#shared-browser-bridge) and the
> [daemon-lifetime ownership](#browser-lifetime-and-teardown) prerequisites
> below.

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
┌──────────────────────── HyperNeo app window (Tauri shell) ──────────────────────────────┐
│  Preact UI (OS webview)                                                                   │
│   └─ <BrowserPane sessionId=…>  ── draws JPEG frames to <canvas>                          │
│        ▲ user mouse/key             │ frames + frameAck (session channel)                 │
│        │                             ▼                                                     │
│        │       MessageHub WebSocket (existing transport)                                    │
│        │       method: "browser.frame" (pub)  |  "browser.frameAck"/"browser.input"/      │
│        │                                            "browser.action" (req)                 │
│        │                             ▲                                                     │
│        │          ┌──────────────────┴───────────────┐                                     │
│        │          │  daemon: BrowserEngineService      │                                     │
│        │          │   • owns the ONE daemon-lifetime   │                                     │
│        │          │     Chromium (per HyperNeo session)│                                     │
│        │          │   • per-page CDP session + screencast │                                 │
│        │          │   • backpressure-gated frame loop  │                                     │
│        │          │     keyed on explicit client ACKs  │                                     │
│        │          │   • epoch-tagged frames + input    │                                     │
│        │          │     router (per active page)       │                                     │
│        │          │   • agent action primitives (MCP)  │                                     │
│        │          └──────────────────┬───────────────┘                                     │
│        │                           │ CDP                                                     │
│        │                           ▼                                                         │
│        │          ┌──────────────────────────────────┐                                      │
│        └─────────▶│  shared headless Chromium         │ ← agent's tools ALSO drive this       │
│                   └──────────────────────────────────┘   (via the bridge; daemon-owned)      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

There are **two distinct webviews** to keep separate in the mental model: the
*app UI* (Preact, rendered by the OS webview) and the *depicted browser*
(headless Chromium, shown as pixels on a canvas). One renders an image of the
other; they are not the same thing.

### Shared browser bridge

The pane must depict the browser the agent is actually driving — not a second,
unrelated browser. Today each browser tool owns an isolated browser it does not
expose: `playwright` drives `@playwright/cli` via `npx`/global install,
`playwright-interactive` creates handles inside a `js_repl` session, and
`chrome-devtools-mcp` owns an isolated MCP-managed browser. A
`BrowserEngineService` that independently launched Chromium would render a page
the agent never touches. Resolving this requires one of:

1. **Service-owned single browser (replace).** `BrowserEngineService` owns the
   one Chromium and the agent's browser actions are reimplemented as MCP tools
   backed by the service. The service exposes `Page`/CDP to both the agent tools
   and the screencast loop. Cleanest model; most new code. **Recommended** — see
   lifetime note below.
2. **Persistent broker + per-query attach.** A daemon-lifetime broker owns the
   Chromium; the per-query MCP process (e.g. a reworked `chrome-devtools-mcp`)
   attaches to the broker's CDP endpoint each turn. Least reimplementation of
   agent actions; requires the MCP tool to be reworked to attach rather than
   spawn its own browser.

Either way, the invariant is: **one Chromium per HyperNeo session, shared by the
agent's actions and the pane.** The naive "attach to `chrome-devtools-mcp`'s own
CDP endpoint" does **not** work on its own — see [Browser lifetime and
teardown](#browser-lifetime-and-teardown).

### Browser lifetime and teardown

HyperNeo supplies MCP servers (including `chrome-devtools-mcp`) as SDK-owned
stdio configuration, and the SDK spawns that subprocess **per query/turn**. A
browser owned by that per-query process is torn down or replaced at the end of
the turn — so it cannot host a pane that is meant to last the whole HyperNeo
session (with its authenticated state). Therefore:

- **Ownership must be daemon-lifetime**, not per-query. Either the service owns
  the Chromium directly (bridge option 1), or a persistent daemon broker owns it
  and per-query MCP processes attach (bridge option 2). This rules out the naive
  "attach to `chrome-devtools-mcp`" bridge.
- **Teardown is part of the surface.** Because the service owns one Chromium per
  session, archive / delete / hard-reset of a HyperNeo session must close that
  session's pages, CDP sessions, browser process/context, listeners, and the
  credential-bearing profile — otherwise session churn leaves orphaned Chromium
  processes and credential-bearing profiles until daemon exit. Add teardown
  hooks for archive/delete/reset and for global daemon shutdown, with an explicit
  profile-retention policy (e.g. delete the profile on session delete, retain on
  archive).

### Component map (proposed; not yet implemented)

| Piece | Proposed location | Notes |
|---|---|---|
| Shared headless Chromium + Playwright | daemon (`BrowserEngineService`) | One daemon-lifetime browser per session; **requires adding a pinned `playwright` runtime dep to `packages/daemon`** (see below) |
| CDP broker | `packages/daemon/src/lib/browser/` | Per-page CDP sessions, backpressure-gated frame loop keyed on client ACKs, epoch-tagged frames, input router to active page |
| Transport | MessageHub — **method `browser.frame`** (pub) scoped by a **session channel**; request methods `browser.frameAck`, `browser.input`, `browser.action` | Method is a plain string (MessageHub forbids colons in methods); session scoping is the `channel` option (`session:<id>`), never baked into the method. Events are fire-and-forget — consumption is signalled by the explicit `browser.frameAck` request |
| Renderer | Preact `<BrowserPane sessionId>` in `packages/web` | Joins the session channel, renders to `<canvas>`, sends `browser.frameAck` after draw, forwards pointer/keyboard via request methods |
| Tauri shell | `packages/desktop` | Rust webview code unchanged. **For the Chromium-bundle path**, the Tauri config (`externalBin`) and `build-sidecar.sh` must add Chromium's executable + resources (see [Chromium packaging](#chromium-packaging-for-release-builds)) |

### Data flow: watch the agent browse

The agent calls an MCP tool → daemon → Playwright acts on the shared browser.
Simultaneously a screencast runs for the **active page**. MessageHub events are
fire-and-forget (there is no `onConsumed` hook), so backpressure is enforced via
an **explicit client→daemon ACK**:

```ts
// ILLUSTRATIVE — see "Screencast correctness rules" below for the binding contract.
// State is keyed per (sessionId, pageId); EACH Stream owns its page's CDP client,
// so an ACK always releases the ORIGINATING page's slot (a frame ACK'd after a
// tab switch belongs to a now-inactive page). MessageHub keeps ONE handler per
// request method, so browser.frameAck is registered once and routed by session +
// frameId.
const cdp = await page.context().newCDPSession(page);

interface Stream {
  cdp: typeof cdp;                                       // owning CDP client for THIS page
  inflight: { frameId: string; cdpSessionId: string; timer: Timer } | null;
  newest: { frame: Frame; cdpSessionId: string } | null;
}
const streams = new Map<string, Stream>();               // key: `${sessionId}:${pageId}`
const ackCdp = (s: Stream, id: string) => s.cdp.send('Page.screencastFrameAck', { sessionId: id });

await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800 });
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const s = streams.get(key)!;
  if (s.newest) ackCdp(s, s.newest.cdpSessionId);        // supersede: ack + drop the queued frame
  s.newest = { frame: { jpeg: data, metadata, frameId: randomUUID(), pageId, epoch, seq: nextSeq() }, cdpSessionId: sessionId };
  if (!s.inflight) dispatch(s);
});

function dispatch(s: Stream) {
  if (!s.newest) return;
  const frameId = s.newest.frame.frameId, cdpSessionId = s.newest.cdpSessionId;
  const timer = setTimeout(() => {                        // captured by frameId; cleared on resolve
    if (s.inflight?.frameId !== frameId) return;          // already resolved by ACK/teardown
    ackCdp(s, cdpSessionId); s.inflight = null; if (s.newest) dispatch(s);
  }, ACK_TIMEOUT_MS);
  s.inflight = { frameId, cdpSessionId, timer };
  gateway.publish('browser.frame', s.newest.frame, sessionChannel);  // event: session:<id> channel
  s.newest = null;
}

// Registered ONCE at startup; request scope is the RAW session id (see rules):
hub.handle('browser.frameAck', ({ frameId }, ctx) => {
  const s = streamByFrameId(ctx.sessionId, frameId);      // search ALL the session's page streams
  if (!s?.inflight || s.inflight.frameId !== frameId) return;  // not found, or stale/resolved
  clearTimeout(s.inflight.timer); ackCdp(s, s.inflight.cdpSessionId); s.inflight = null;
  if (s.newest) dispatch(s);
});

// teardown / pane leave: ack BOTH retained frames on every stream, clear timers
onSessionLeave(sid => { for (const s of streamsFor(sid)) {
  if (s.inflight) { clearTimeout(s.inflight.timer); ackCdp(s, s.inflight.cdpSessionId); }
  if (s.newest) ackCdp(s, s.newest.cdpSessionId);
  s.inflight = s.newest = null;
}});
```

Frames flow daemon → WS → canvas at roughly 10–30 fps depending on quality/size.
Stop with `Page.stopScreencast`.

#### Screencast correctness rules (required)

`Page.screencastFrameAck` is CDP's only flow-control point, MessageHub events are
fire-and-forget (no `onConsumed`), and MessageHub keeps a single handler per
request method. These invariants are the binding contract for the loop above:

- **Ack every CDP frame exactly once.** Each received frame must be acked — the
  forwarded frame after the client ACKs it; a superseded queued frame when
  overwritten; the in-flight frame on ACK-timeout, teardown, or pane disconnect.
  Missing any one leaks a bounded slot and stalls delivery.
- **One service-level `browser.frameAck` handler.** Register it once at startup
  and route by `CallContext.sessionId` + `frameId`; per-page registration would
  overwrite MessageHub's single handler-per-method slot.
- **Cancel timers on resolve.** Capture the `frameId` a timeout belongs to and
  `clearTimeout` it on ACK/teardown/disconnect; a stale timer must never ack or
  clear a newer frame.
- **Teardown acks both retained frames.** On pane leave / page close / session
  end, ack `inflight` (clearing its timer) **and** `newest`, then drop both.
- **Late-subscriber activation snapshot.** `browser.activated` is fire-and-forget
  and MessageHub does not replay it, and `channel.join` returns only an ack — so
  the pane must complete an explicit `browser.activationSnapshot` request on
  mount/reconnect **before** consuming the stream, returning the current
  `{ pageId, epoch }` (and the latest frame). A pane mounting after a switch then
  knows the epoch it must match.
- **Pane guards its channel.** A client may have joined several `session:*`
  channels and MessageHub dispatches by method name, so the pane's frame and
  activation handlers must explicitly require `context.channel === 'session:<sessionId>'`.
- **Requests use the raw session id; events use the channel string.**
  `MessageHub.request` writes `options.channel` into the wire message's
  `sessionId` field, which `getSessionAsync` then resolves — so request methods
  (`browser.frameAck` / `browser.input` / `browser.action`) must be scoped with
  the **raw** HyperNeo session id, while the `session:<id>` string is reserved
  for **event** routing (`browser.frame`, `browser.activated`) only. Conflating
  them makes every request fail session lookup.
- **Multiple subscribers:** if more than one pane can subscribe to a session
  (e.g. desktop + browser tab), require an ACK from each, or document a
  single-subscriber-per-session assumption.
- **Route ACKs by frameId across all page streams.** The ACK'd frame may belong
  to a page that is no longer active (it was in flight during a tab switch), so
  look the owning stream up by `frameId` across the session's pages — selecting
  the active page would reject a valid ACK and leak its CDP slot until timeout.
- **Monotonic frame sequence.** Each frame carries a monotonic `seq`; the pane
  discards any decode/draw completion whose `seq` is older than the latest frame
  it displayed, so a slow decode of an older frame cannot overwrite a newer one
  within the same epoch (MessageHub does not serialize async event handlers, so
  the epoch check alone cannot catch this).
- **Reset held input state on interrupt.** On pane disconnect, blur, teardown, or
  epoch change, release every held modifier and mouse button and clear the
  per-client pressed-state set — otherwise a gesture interrupted between down and
  up leaves Playwright (and the next action) with a stuck Ctrl/Shift/button.

### Data flow: human drives (or takes over)

The user interacts with the pane. Coordinates are mapped from the **decoded
frame dimensions and `screencastFrame` metadata**, then forwarded through
Playwright so events are trusted. **Critically, Playwright mouse coordinates are
CSS pixels relative to the viewport, not the document** — so the document scroll
offset must **not** be added (the screencast already depicts the current
viewport; adding scroll would click the wrong place on any scrolled page):

```ts
// metadata: pageScaleFactor, deviceWidth, deviceHeight (the viewport). scrollOffsetX/Y is
// informational ONLY — do NOT add it (Playwright wants viewport-relative coords).
// frame decoded to frameW×frameH; drawn at displayW×displayH with letterbox (offX, offY).
const fx = cx - offX, fy = cy - offY;                                        // 1. remove letterbox
const cssX = (fx / displayW) * metadata.deviceWidth  / metadata.pageScaleFactor;   // → viewport CSS px
const cssY = (fy / displayH) * metadata.deviceHeight / metadata.pageScaleFactor;
```

#### Pointer-event protocol (required)

Forwarding only `page.mouse.click` does not give real human takeover — it
cannot reproduce scroll, drag, hover, or press-and-hold. Forward the full set,
each with button + modifier state and the same viewport-coordinate transform
above:

| Client event | Playwright call |
|---|---|
| move | `page.mouse.move(cssX, cssY)` |
| button down | `page.mouse.down({ button, clickCount })` |
| button up | `page.mouse.up({ button, clickCount })` |
| wheel | `page.mouse.wheel(deltaX, deltaY)` |
| modifier hold (Ctrl/Shift/Alt/Meta) | `page.keyboard.down(modifier)` at gesture start; `page.keyboard.up(modifier)` at gesture end |

Compose click/drag from down→(move)→up at the client; the broker forwards each
transition. **Modifiers are held across the entire gesture, not per mouse
event.** For a Ctrl-drag, `keyboard.down('Control')` precedes the move/down/up
sequence and `keyboard.up('Control')` follows the final button-up, so the page
sees consistent modifier state throughout (releasing after each mouse action
would drop it mid-gesture). Maintain a pressed-modifier set keyed to the client's
keydown/keyup. Playwright's `mouse.down`/`mouse.up` take no `modifiers` option —
they inherit from preceding `keyboard.down` calls — or use raw CDP
`Input.dispatchMouseEvent` with its modifier bitmask on every pointer event.

#### Keyboard-event protocol (required)

`page.keyboard.type(text)` only inserts a text string — it cannot do Tab, Enter,
Escape, arrows, modifiers, shortcuts, or IME. Use a real keyboard protocol, and
keep the key-event and text-insertion paths **mutually exclusive for printable
keys** so they are not double-inserted (Playwright's `keyboard.down('a')`
already produces the `a` input for a printable key; feeding the same key to
`type`/`insertText` afterwards inserts it again):

| Client event | Playwright call | Notes |
|---|---|---|
| non-printing / control key (Tab, Enter, arrows, Esc, modifiers, shortcuts) | `page.keyboard.press('Tab' \| 'Enter' \| …)` or `down`/`up` | keydown/keyup with modifiers |
| printable text | `page.keyboard.type(text)` **or** `keyboard.down`/`up` per key — not both | pick one path per key |
| IME composition / commit | CDP `Input.insertText` (or `imeSetComposition`) | suppress the duplicate text event |

Focus follows the active page's focused element.

### Tab/page lifecycle and epoch tagging (required)

`newCDPSession(page)` is bound to one target; it does not follow tab switches,
popups, or `target="_blank"` navigations. For multi-tab (a cited reason for
choosing this approach) the broker must:

- Open a CDP session **per page** and screencast only the **active** page (stop
  or suppress inactive streams so every tab does not encode).
- **Tag every frame with `pageId` + `epoch`** (epoch increments on activation
  change). A tab switch cannot be made atomic merely by stopping the old
  screencast and repointing input — a stale old-epoch frame may already be in the
  WS pipeline and arrive *before* the first new-epoch frame.
- **Announce activation out-of-band, and stamp input with epoch (required).**
  Because a frame is the wrong carrier for the *first* signal of a new epoch,
  the daemon sends an explicit `browser.activated { pageId, epoch }` event the
  instant it switches the active page — before any frame for the new page and
  before it repoints input. The pane bumps its expected epoch on receipt and
  disables input until it renders the first frame whose `epoch` matches.
  Independently, every `browser.input` request carries the pane's currently
  displayed `epoch`, and the daemon **rejects inputs whose epoch ≠ the active
  epoch** — a belt-and-suspenders guard against the stale-frame race. Together
  these make the render + input switch atomic.

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
   the credential trust boundary — broader than a normal browser, where
   keystrokes stay inside the browser process.
2. **Recording / rewind is the dangerous one.** HyperNeo persists messages and
   has rewind/checkpoints. If frames or input events are wired into that
   persistence naively, **passwords can be captured to disk** — as input logs or
   as frame pixels (especially if anyone toggles "show password"). Sensitive-page
   frames and keystrokes must be **excluded from recording by design**, and the
   per-session channel routing must never broadcast frames across sessions (one
   session's pane must not render another's authenticated pixels).
3. **The agent can read the authenticated session.** The same shared Chromium is
   also drivable by the agent over the same CDP session. Once a human logs in,
   the agent (and any code with CDP access) can run
   `page.evaluate(() => document.querySelector('input[type=password]').value)`,
   read cookies via `page.context().cookies()`, read `localStorage`, or
   screenshot. This is intentional for a single-user tool (the agent reuses the
   human's session) but must be a conscious decision — there is no isolation
   between "what the human typed" and "what the agent can see."
4. **Isolate the Chromium.** Dedicated Playwright browser context/profile per
   session; do not share cookies or credentials with the host app or the user's
   main browser profile unless intended. Tie profile lifetime to session
   lifecycle ([Browser lifetime and teardown](#browser-lifetime-and-teardown)).
5. **No OS-keychain autofill by default.** A headless Chromium has no system
   keychain and an empty profile, so password managers will not fill. The human
   types the password, and it then lives in the Chromium's cookies/profile until
   the session's teardown policy clears it.
6. **Redact browser traffic from MessageHub logs (required).** MessageHub logs
   full inbound/outbound message objects at `LOG_LEVEL=debug`/`trace`
   (`packages/shared/src/message-hub/message-hub.ts`). Routed naively,
   `browser.input` would log passwords and IME text and `browser.frame` would
   log authenticated page pixels as base64 — and excluding them from
   rewind/persistence does **not** prevent that disclosure. Add method-specific
   payload redaction or suppression for `browser.input` / `browser.frame`
   (e.g. log only metadata, never the payload) before this traffic is routed
   through MessageHub.
7. **Secure the persistent broker's CDP endpoint (required for bridge option 2).**
   A CDP endpoint grants complete control of the authenticated browser — cookies,
   storage, screenshots, arbitrary page evaluation — and raw Chromium
   remote-debugging has no application-level auth. Require a loopback-only (or
   OS-permissioned) transport behind an authenticated broker/proxy; never bind it
   broadly or log the endpoint. Any local process — or any network peer if it is
   exposed beyond loopback — could otherwise attach alongside the MCP process and
   steal the session.

## Tradeoffs

| Aspect | Notes |
|---|---|
| Latency | Screencast is watchable but not instant — a frame or two of round-trip. Fine for watching an agent; not a daily-driver browser. Tunable via quality/maxWidth. |
| New runtime dependency | `packages/daemon` does **not** depend on Playwright today (only `packages/cli` and `packages/e2e` do; the skill uses `@playwright/cli` via npx/global). This feature must **add a pinned `playwright` runtime dependency to the daemon** — not treat an existing dev dependency as packaging-only — so `BrowserEngineService` can import it and the bundle/checksum has a locked version. |
| Ships Chromium | Not free in release builds. Requires a real packaging strategy (see below). |
| Two webviews | App UI (OS webview) vs. depicted browser (Chromium as pixels). Keep them distinct. |
| Input ownership | Decide arbitration: when the agent is mid-action and the user clicks, does it queue or interrupt? Make human input able to pause/override; don't leave it implicit. |
| Sandboxing | The Chromium executes agent-influenced code on arbitrary sites. Sandbox it: per-session context/profile, no shared credentials with the host app, ideally network/FS restrictions. |

### Chromium packaging for release builds

The daemon has no Playwright today and the compiled desktop sidecar bundles only
the `hyperneo` executable, so Chromium will **not** appear by lazy download on a
clean user machine. The implementation must pick one and wire it end-to-end:

- **Bundle** Playwright's Chromium into the desktop release. This is **not**
  transparent for `packages/desktop`: the Tauri config (`externalBin`) and
  `build-sidecar.sh` currently bundle only the `hyperneo` sidecar, so they must
  add Chromium's executable + resource tree, locate it at runtime, and thread it
  through the platform release/signing pipeline. (The Rust webview code itself
  can stay unchanged.)
- **First-run installer** that downloads Playwright + the browser binary on
  first use, with progress UI, retry/checksum verification against the locked
  version, and a defined failure path (degraded mode that disables browser-use
  but keeps the app usable).

Either belongs in the implementation surface before this feature ships.

**Standalone CLI distributions too.** The bundle path covers only the Tauri
release; HyperNeo's separately compiled `hyperneo` CLI binaries can also host the
web UI and would still have no Chromium on a clean machine. Extend whichever
strategy is chosen to the standalone CLI artifacts, or require the first-run
installer for every non-desktop distribution.

## Proposed Implementation Surface

All proposed, none present today:

| File / area | Change |
|---|---|
| `packages/daemon/package.json` | Add a pinned `playwright` runtime dependency |
| `packages/daemon/src/lib/browser/` (new) | `BrowserEngineService` — owns the daemon-lifetime shared Chromium, per-page CDP sessions, backpressure-gated frame loop keyed on `browser.frameAck`, epoch-tagged frames, input router, agent action primitives (MCP) |
| Existing browser skills | Reimplemented on the service (replace) **or** reworked to attach to a persistent daemon broker (attach) — see [Shared browser bridge](#shared-browser-bridge). The naive attach to `chrome-devtools-mcp` does not survive a query boundary. |
| MessageHub (new) | Events: `browser.frame` + `browser.activated` (pub, `session:<id>` channel). Requests (raw session-id scope): `browser.activationSnapshot` (handshake on mount → `{ pageId, epoch }`), `browser.frameAck`, `browser.input` (carrying displayed `epoch`), `browser.action`. No `onConsumed` — ACKs explicit. |
| MessageHub logging | Method-specific redaction for `browser.input`/`browser.frame` so debug/trace logs never carry passwords, IME text, or authenticated page pixels |
| Session lifecycle | Teardown hooks on archive/delete/hard-reset + daemon shutdown: close pages, CDP sessions, browser, listeners, credential-bearing profile; profile-retention policy |
| `packages/web` (new component) | Preact `<BrowserPane sessionId>` — joins session channel, renders to `<canvas>`, sends `browser.frameAck`, maps pointer coords from frame metadata, forwards pointer + keyboard protocols, suppresses input across epoch changes |
| `packages/desktop` (config/build only) | For the bundle path: add Chromium to `externalBin`/bundle + `build-sidecar.sh`; locate at runtime; release/signing. Rust webview code unchanged. |

### Suggested spike (validation slice)

Validate latency, coordinate-math, backpressure, and epoch behavior with a
minimal slice (no Tauri, service-owned bridge):

1. A daemon service that owns one headless Chromium, opens per-page CDP
   sessions, and runs the ACK-gated screencast loop.
2. Agent actions exposed as MCP tools against that same Chromium.
3. A standalone HTML page (`<BrowserPane>` prototype) that joins the session
   channel, renders frames, ACKs them, maps clicks from frame metadata,
   forwards pointer + keyboard, and honours epoch tags.

Enough to confirm the feel, then wire into the real UI and the desktop shell.

## Open Questions

Resolved in this revision (specified, not yet implemented):

- **Shared-browser bridge** — pane depicts the agent's browser; service-owned (replace) vs. persistent broker + per-query attach.
- **Daemon-lifetime ownership + teardown** — the browser must outlive one query; session teardown closes browser + profile.
- **MessageHub wiring** — stable `browser.frame` method + session channel; explicit `browser.frameAck` request (no `onConsumed`); disconnect/timeout/multi-subscriber defined.
- **Screencast backpressure** — at most one frame in flight; ack CDP after client ACK.
- **Tab/page lifecycle + epoch tagging** — per-page CDP sessions; frames carry `pageId`/`epoch`; pane suppresses input across epoch change for an atomic switch.
- **Pointer protocol** — move/down/up/wheel, viewport-relative coords (no scroll offset), letterbox-corrected.
- **Keyboard protocol** — keydown/keyup/press/text mutually exclusive for printable keys; `insertText` for composition.
- **Playwright runtime dependency** — add pinned dep to `packages/daemon`.
- **Chromium packaging** — bundle (with desktop config/build changes) vs. first-run installer.

Round-3 (mechanism correctness):

- **CDP frame acking** — every received frame acked exactly once: forwarded frames on client ACK, dropped frames (superseded / ACK-timeout / teardown) immediately.
- **Activation out-of-band + epoch on input** — `browser.activated {pageId, epoch}` event sent before repointing input; `browser.input` carries the displayed `epoch` and the daemon rejects mismatches, for an atomic tab switch.
- **Log redaction** — `browser.input` / `browser.frame` payloads redacted in MessageHub debug/trace logs (passwords, IME text, authenticated pixels).
- **Pointer modifiers** — held via synchronized `keyboard.down`/`up` (or CDP `Input.dispatchMouseEvent` bitmask), since Playwright `mouse.down`/`up` have no `modifiers` option.

Round-4 (transport invariants and distribution):

- **Screencast loop invariants** — single service-level ACK handler routed by session + frameId; timers cancelled on resolve; teardown acks both inflight and newest; late subscribers get an activation snapshot; pane guards its channel; requests use the raw session id, events use the `session:<id>` channel string.
- **Whole-gesture modifiers** — held across the full pointer gesture, not per mouse event.
- **Chromium in CLI distributions** — bundle/first-run strategy extended to standalone CLI artifacts, not just the desktop release.

Round-5 (P2 robustness):

- **ACK routing by frameId** — across all the session's page streams, not the active page (handles in-flight frames during tab switches).
- **Monotonic frame sequence** — pane discards stale decodes so a slow older frame can't overwrite a newer one within an epoch.
- **Input-state reset on interrupt** — held modifiers/buttons released on disconnect/blur/teardown/epoch change.

Round-6 (transport correctness + scope):

- **Owning CDP client per stream** — each Stream stores its page's CDP session; ACKs route through it so a post-switch ACK releases the originating page's slot.
- **Concrete activation handshake** — `browser.activationSnapshot` request completed on mount before streaming (`channel.join` returns only an ack).
- **Secured CDP endpoint** — loopback-only + authenticated broker for the persistent-broker option.
- **Persistent-profile rehydration** and **clipboard bridge** — logged as open questions (new scope).

Still open:

- **Bridge choice** — service-owned (replace) vs. persistent broker (attach). The central decision; drives how much existing skill code is rewritten.
- **Multi-subscriber frame ACK semantics** — ACK-from-all vs. single-subscriber-per-session assumption.
- **Input arbitration semantics** — queue vs. interrupt when human and agent both act.
- **Recording exclusion mechanism** — how sensitive-page frames and keystrokes are identified and excluded from rewind/persistence.
- **Credential policy** — whether the agent may read authenticated sessions at all, or only for an explicit allowlist of origins.
- **Chromium lifecycle host** — daemon-managed vs. (optionally) Tauri-shell-managed.
- **Persistent-profile rehydration** — daemon-lifetime Chromium dies on restart/upgrade; define a stable per-session user-data dir with lazy reopen so authenticated state survives a daemon restart, plus restart-recovery and cleanup.
- **Clipboard bridge** — copy/paste does not cross the remote-browser ↔ user-machine boundary (`page.keyboard` paste reads the daemon host's clipboard, not the user's). Define consent-aware copy/paste payloads between pane and broker, with the same sensitive-input log redaction.
