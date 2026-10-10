# Neo-started Claude Code Desktop sessions on the Claude mobile app

Research only, no code changes. Date: 2026-10-09. Claude Code 2.1.295, HyperNeo `origin/dev` at `c33047d44c`, neo-ios `main` checkout.

## Short answer

A Claude Code Desktop session shows up in the Claude mobile app (and at claude.ai/code) only while Remote Control serves it. Neo starts a session in the CLI and then hands it to Desktop with `claude --desktop --resume <id>`. Desktop treats that as an adopted session, and adopted sessions don't auto-connect to Remote Control, even with **Connect new sessions to Remote Control** turned on. So the session never gets a `session_…` bridge. Neo can't build a direct link, and iOS falls back to the generic `https://claude.ai/code` list.

Two things are broken:

1. **Claude's side (we can't fix it):** the auto-connect setting skips sessions adopted from the CLI, and `--desktop` refuses `--remote-control`. Nothing we can pass at start time connects Remote Control.
2. **Our side (small fix):** `claudeRemoteLink()` only builds a link when `remoteControlUserEnabled` is true. That drops sessions that connected automatically, which record a bridge without setting that flag. For example, `neo-outcome-driven` is live on Remote Control right now but gets no `remoteLink`.

## Evidence

### What Desktop records (85 records in `~/Library/Application Support/Claude/claude-code-sessions/`)

Fields read from every record: `remoteControlUserEnabled` (rc), how many `bridgeSessionIds` it has, and `adoptedFromOtherSurface`.

| rc | bridges | adopted | count |
|---|---|---|---|
| unset | 1+ (`session_…`) | unset | 50 |
| unset | 0 | **true** | **19** |
| true | 1+ | unset | 6 |
| true | 1 | true | 1 (the "Neo iOS app" session, switched on by hand) |
| unset | 0 | unset | 5 |
| other mixes | | | 4 |

Every one of the 19 sessions adopted through `--desktop --resume` (all the `neo-xxxxxxxx` sessions Neo started) has zero bridges. The only adopted session with a bridge is one where the user turned Remote Control on by hand. Most sessions created natively in Desktop have a bridge even though `remoteControlUserEnabled` is unset. They connected automatically.

`list_sessions` and `get_session` from the Desktop app match this:

- This session, `local_42ecc479…` (started by Neo, adopted): `remoteControlState: "off"`, even though `connect_new_sessions_to_remote_control` is `true`.
- `local_0bd1502f…` "neo-outcome-driven": `remoteControlActive: true`, rc unset, 1 bridge. Today's `claudeRemoteLink` returns nothing for it.
- Every Neo-started session in the list has `remoteControlActive: false`.

### Probe (one throwaway session, `rc-probe`)

1. `claude -p --session-id <id> -n "rc-probe" -- "Reply only: ok"` → ok.
2. `claude --desktop --remote-control --resume <id>` → the CLI refuses: `--desktop` can't be combined with `--remote-control`. **Confirmed.**
3. `claude --desktop --resume <id>`, the exact handoff Neo uses → it opens in Desktop with `remoteControlState: "off"` and `remoteControlActive: false` while auto-connect is on. **Confirmed.**
4. Turning Remote Control on for that one session (`ccd_session_mgmt.set_remote_control`) → the auto-mode classifier blocked it in this session, so **it's untested whether the per-session switch works on an adopted session.** That tool's description says it "needs a session that has run a turn" and is "refused for … unattended ones". The "Neo iOS app" record shows a person can switch it on by hand.

The probe is still in the Desktop sidebar as "rc-probe (throwaway)". Desktop refused to archive it while it's open on screen, so archive it from the sidebar.

### Anthropic docs

- [Desktop: Control which sessions appear on your other devices](https://code.claude.com/docs/en/desktop#control-which-sessions-appear-on-your-other-devices): a local session appears on other devices once Remote Control connects it. That happens either when you switch it on for that session (the switch or `/remote-control`) or because it connected automatically "as it starts" while **Connect new sessions to Remote Control** is on. The setting covers *new Desktop sessions*. Nothing in the docs says CLI sessions adopted with `--desktop --resume` count. Our records show they don't.
- [Remote Control](https://code.claude.com/docs/en/remote-control): Remote Control turns on only when explicitly started or when auto-connect is on. `remoteControlAtStartup` applies to *interactive* sessions, so it doesn't apply to `claude -p`. The session ID is the part of `claude.ai/code/<id>` after `/code/`. The session goes offline when the local process stops. Resuming in Desktop a conversation that *had* Remote Control on reattaches it to the existing claude.ai session.
- [Desktop: Coming from the CLI](https://code.claude.com/docs/en/desktop#coming-from-the-cli): documents `claude --desktop --resume <id>`. It says nothing about Remote Control.
- [Deep links](https://code.claude.com/docs/en/deep-links): `claude-cli://open` opens a terminal, and `claude://code/new` opens Desktop's new-session page. Both only work on the desktop, and the prompt is pre-filled but not sent. Neither can start an unattended Desktop session, and neither runs on iOS.
- The SDK's `remoteControlAtStartup` doesn't apply here: Neo's Claude Desktop path uses the `claude` CLI, not the SDK.

## The questions

**(a) Why doesn't a new Neo-started session appear on mobile?** The mobile Code list shows only sessions that Remote Control serves. A Neo-started session is created by `claude -p` (non-interactive, so no Remote Control) and then adopted by Desktop (adoption doesn't auto-connect). It is never published. It isn't waiting for activity: this session has been active and is still off. *Confirmed* (records, `get_session`, probe).

**(b) Why does "send it a message from another session" wake it?** *Not confirmed.* The records don't show any adopted session getting a bridge from a relayed message. This session and other Neo sessions have received relayed messages and are still off. The only adopted session that is connected was switched on by hand. The most likely explanations, both *inferred*: the session that "appeared" was one with Remote Control already on (natively created, or switched on by hand), or the message was sent from a Desktop session that turned Remote Control on for it. To settle it: note `remoteControlState` before and after a wake on a fresh Neo session.

**(c) What does Neo record today?**

- `link` is always `claude://claude.ai/epitaxy/<local_id>` (`claude-desktop-adapter.ts:203`). That route opens only the Mac app, and iOS never opens it.
- `remoteLink` is `https://claude.ai/code/<last bridge>` only when `remoteControlUserEnabled === true` **and** the last `bridgeSessionIds` entry matches `^session_[A-Za-z0-9]+$` (`claudeRemoteLink`, `:181`).
- On **start**, the result is built from a synthetic record with no Remote Control fields (`startClaudeSession`, `:777`), so `remoteLink` is always missing at start.
- After that, `settleDriverWork` (`neo/service.ts:848`) reads `work.status`, which re-reads the record on disk, and `recordLive` sets `remote_link` on every change (`neo-work-driver-target-repository.ts:134`, which clears it when it disappears). The card picks up a link as soon as the record qualifies.
- So `remoteLink` is present only for sessions where the user switched Remote Control on (rc=true with a bridge). It is missing for Neo-started sessions (no bridge) and for sessions that connected automatically (bridge, but rc unset).
- iOS (`Models.swift:189`) opens `remoteLink` when it matches the `session_` pattern. Otherwise any `claude://` link becomes `https://claude.ai/code`, the generic view (`:196`, plus `fallbackURLs` at `:177`). iOS is behaving correctly with what it gets.

**(d) Does Remote Control gate a directly openable link?** Yes. The only directly openable URL is `https://claude.ai/code/session_…`, and that ID exists only after Remote Control connects the session. There is no ID-based mobile link for a local session. `remoteControlUserEnabled` is the wrong gate, though. Whether a bridge exists is what matters. Auto-connected sessions have a bridge without the flag. *Confirmed* (records plus docs).

## Recommendation

### 1. Smallest change, neokai (about 1 prod line): gate on the bridge, not the flag

```ts
const bridge = record.bridgeSessionIds?.at(-1);
```

This gives a working Open for every session that has ever been connected. That includes all sessions created natively in Desktop while auto-connect is on (most of the 50), and sessions Neo `send`s work into. No iOS change is needed.

Tradeoff: `bridgeSessionIds` keeps old entries after Remote Control disconnects, or after the app quits. The link then opens the right session on claude.ai showing as offline, not the generic list. That's still better than today. Showing live status needs Desktop's own `remoteControlActive`, which isn't in the record file.

This change doesn't fix Neo-*started* sessions, because they have no bridge at all.

### 2. Neo-started sessions: what we can do

- **Make the card say so (neo-ios, small).** When a `claude-desktop` card has no `remoteLink`, label Open "Open Claude Code (not on your phone yet)", or show a one-line hint: "Turn on Remote Control for this session on the Mac to follow it here." Today it silently lands on the generic list. This is cheap and honest.
- **Turn Remote Control on after adoption (untested, needs one experiment).** Inside Desktop, a session can turn on its own Remote Control switch (`set_remote_control "self"`). The app asks the user to approve, and auto mode may decide on its own. Neo's opening message could ask the new session to do that once. Then the bridge appears and change 1 surfaces the link within one settle tick. Risks: the tool is meant for "only when the user asks", the call may be refused for unattended sessions, and an approval card defeats the hands-free goal. Before building anything, run it once on a fresh Neo session with the user present.
- **Don't do these:** passing `--remote-control` to `--desktop` (rejected), relying on `remoteControlAtStartup` (ignored by `-p` and by adoption), or warming with extra turns (activity doesn't bridge).

### 3. Claude's side (report upstream)

The real fix belongs to Claude: an adopted session (`claude --desktop --resume`) should honor **Connect new sessions to Remote Control**, or `--desktop` should accept `--remote-control`. Either one would make change 1 cover Neo-started sessions with no other work on our side. This is worth a feedback report through `/bug`, citing the probe above.

### Suggested order

1. neokai: drop the `remoteControlUserEnabled` gate (change 1) and pin it with a test: rc unset plus a bridge → link.
2. neo-ios: give a card without a `remoteLink` an accurate label or hint.
3. Run the self-switch experiment once. Build it only if it works without a prompt in auto mode.
4. File the upstream report.
