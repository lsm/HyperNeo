# Neo MVP

An opt-in entry inside the existing web package at `/neo`, included in the web build. The old `/neo/index.html` URL and `/neo/` redirect to `/neo`, preserving query parameters. Development, build preview, and production servers serve the same entry. The normal HyperNeo entry remains unchanged. Requires this branch's daemon (schema migration 278) and a configured model provider.

## Working loop

- Messages use existing sessions, message delivery and live subscriptions. One-off messages do not mechanically create concerns; Neo decides when continuity justifies one.
- A 分身 is a durable concern record, independent of its coordinator conversation and execution sessions. Neo reads short summaries, then loads relevant context on demand. Corrections use revision protection.
- Root Neo and concern coordinators have only question cards and bounded Neo operations. They cannot start work, run shell/file tools, spawn agents, or access arbitrary external MCP servers.
- Work proposals show the actual brief. Start creates an ordinary HyperNeo execution session using existing tools and permissions, with no new execution engine. Workspace-less executions run in a per-work temporary scratch directory (`$TMPDIR/hyperneo-neo-work/…`) in direct mode, so auto-accepted edits never land in the daemon's launch directory; the card says so. Repeated Start calls reuse the same receipt/session. Stop interrupts without undoing completed effects.
- Terminal responses return through the durable mailbox to Neo and the originating concern conversation. “Response ready” is not independently verified task completion. Execution history stays inspectable.
- Concerns, conversations, proposals and results survive refresh/restart. Drafts are isolated while switching views but remain browser-memory-only. Reconnection refreshes snapshots and transcripts.
- Accent colors identify contexts without defining fixed categories. Motion is subtle and respects reduced-motion settings.
- A full-width scroll surface runs behind the width-capped floating composer. Readable message bubbles stay in a narrower rail with a 160px minimum width. Names and local timestamps sit above each bubble (time today, date and time on other days); full timestamps are available on hover. Copy controls below each message copy its text, without metadata or internal tool output. The concerns card stays visible on wide screens and parks behind a header icon on smaller screens.
- One searchable, provider-grouped model picker and inline thinking buttons use existing session APIs. Duplicate provider/model entries are collapsed. Arrow keys move through results; Escape closes the picker and returns focus. Changes wait while Neo is working. No extra execution or provider settings are introduced.
- The model list shows names only in a taller list. The composer reuses HyperNeo's light-bulb thinking indicator. Conversation details have a separate right-aligned full-conversation link and a bottom close control.
- Both sides render Markdown: muted peach/copper accents and a subtly warm bubble for Neo, cool blue accents for the human bubble. Rich, non-persistent examples at `/neo?examples` include a local light/dark toggle that does not change app settings.
- The plus button, clipboard paste and whole-window drop area accept photos (PNG/JPEG/GIF/WebP, up to 3.75 MB each) and UTF-8 text files (up to 128 KB each). Up to six attachments and 8 MB combined payload are allowed. PDF, Office and other binary documents are explicitly unsupported. Text files are sent as fenced source content through the existing message path; photos use the existing image payload. Attachments alone can be sent. Pending attachments stay scoped to the conversation in browser memory, survive view switches, and are retained on failure; refresh clears them.
- Voice appears only when enabled with a configured endpoint/model. It reuses the recorder and transcription pipeline, inserts into the original conversation's draft for review, and exposes saved recordings for retry. Switching contexts cancels active capture; a transcription already underway returns to its original draft. Drafts remain memory-only, including transcribed text.

## Message themes

`neo.css` is the single customization point for Neo's message colors. The `.neo-shell` block defines `--neo-user-*` and `--neo-assistant-*` tokens for accent, background, border, text, heading, emphasis, link, quote, quote background, code, code background, and table background. Name and timestamp colors use `--neo-message-label` and `--neo-message-time`. Role classes apply those tokens; components contain no bubble color utilities.

The warm accent uses `light-dark()` with the existing app color scheme; other defaults derive from shared surface/text tokens. Override the named variables on the Neo shell to create another palette without editing components. Shared Markdown structure and syntax-highlighting tokens (`--hljs-*`) continue to come from `styles.css`; they are not duplicated or changed globally. Live conversations and examples use the same component and stylesheet.

## Deliberate MVP limits

Single-user local use. Each delegation currently creates its own execution session; no automatic import/linking of existing Spaces or task histories, concern merge/archive, scheduling or proactive reminders. The model can still misroute or poorly summarize context; inspect the saved context and correct it conversationally. Recent work is limited to 50 receipts in this UI; execution history remains in HyperNeo.

The old `NeoPreview` component remains a test fixture, not the live entry. No sample concerns are seeded in the live app.

## Local run

Use an isolated `DB_PATH` and workspace root for testing. Run the daemon, then start web with `DAEMON_URL` pointing to its port. Existing provider discovery is reused; never copy credentials into this package.

Browser acceptance checks: one-off question; continuing concern; correction reuses it; reload retains both; approve a bounded draft-only task; inspect returned result; open the concern; answer a choice card; switch back with the original draft intact; inspect desktop and mobile layout. Test cancellation, duplicate actions, scope restrictions and terminal attribution in the focused unit suite.
