# Neo life-admin pack

Status: proposal for decision. Nothing here is implemented.
Scope: the second Neo pack (ADR 0009 rung e), replacing the legal-review pack.
Tracks: epic #6230.

## What it is for

Life admin is the work people have to do but don't want to: answering the inbox, booking and rescheduling, ordering, cancelling subscriptions, watching for a price or a slot. Across this year's usage studies and the personal agents that launched (Muse, Grok Bot, Instinct, Manus), these are the tasks people hand off end to end, rather than ask about:

| Task | Typical ask | Done when |
|---|---|---|
| Inbox | "clear my inbox, draft what needs me" | replies sent or drafted, the rest archived or labelled |
| Scheduling | "move my dentist to next week" | the event is on the calendar and the other side has confirmed |
| Orders | "reorder the water filters" | an order confirmation arrived |
| Bookings | "dinner for 4 Friday near the office" | a booking confirmation arrived |
| Subscriptions and bills | "cancel the gym", "find what I'm paying for that I don't use" | a cancellation confirmation arrived, or a list of charges was delivered |
| Watching | "tell me when the SFO fare drops under $400" | the alert fired, or the watch was stopped |

Writing and research stay out. Any chat app does those. What an agent adds is acting where the user is logged in, so this pack is about acting in the user's accounts and proving the result.

## What makes it different from the other agents

The others say "booked". Neo already drives an ask to an outcome and checks it before saying done. For life admin the proof is almost always a message the other side sends: an order or booking confirmation, a cancellation notice, a calendar acceptance. So the pack's done rule is:

> An action counts as done when its confirmation is in the user's inbox or calendar. A screenshot of a success page is not enough.

That one rule covers orders, bookings, cancellations and scheduling. Inbox and watching are checked by their own result: the drafts or alert exist.

## Access: the user's own browser first

Life admin happens on sites the user is already logged into. The pack never asks for or stores passwords.

| Option | How | Verdict |
|---|---|---|
| 1. The user's own Chrome | HyperNeo runs on the user's computer. The worker attaches to the Chrome they already use through `chrome-devtools-mcp --autoConnect`, after Chrome's own consent prompt. Sessions, cookies and saved logins are the user's, as is. | **v1.** Nothing to set up. Work happens in its own window so it doesn't take over the user's tabs. |
| 2. A managed profile | A persistent Chrome profile owned by HyperNeo (`--userDataDir ~/.hyperneo/browser/<profile>`). The user signs in once, themselves, through a visible window or the in-app browser pane (`docs/design/in-app-browser.md`). Cookies persist; Neo never sees the password. 2FA is handed to the user. | **v2**, for always-on work when the user's computer is asleep or the daemon runs remotely. |
| 3. A credential vault or a man-in-the-middle proxy | The agent stores passwords and replays them, or a proxy captures them (Muse's approach). | **Rejected.** It holds the user's secrets and is a single point of compromise. A password manager the user approves per item (1Password-style autofill) is the only acceptable variant, and only later. |

Login pages, passwords, 2FA codes, CAPTCHAs and payment details are always handed to the user. The worker stops, the card goes to needs-you, and it resumes when the user says done.

## Approval before anything leaves

Anything that sends, pays, books, cancels or accepts terms needs the user's yes first. That uses what core already has:

- The worker prepares the action and stops at the final click.
- Neo adds a decision item (#6270): "Approve: book Nobu, Fri 7:30pm, 4 people, $50 deposit on your saved card". It shows on the card as needs-you with a Done button.
- The user approves on the card or in chat, and the worker completes it.
- A standing rule can pre-approve a class ("reorders under $50 from Amazon don't need asking"). Neo saves and announces it the same way it saves done rules.

## The pack

A built-in pack, `life-admin`, shipped disabled and enabled in settings.

- `describe`: "Life admin: inbox, scheduling, orders, bookings, subscriptions, watches. Acts in the user's own browser and accounts, proves results with confirmations."
- `instructions` (the `SKILL.md` body): the done rule above, the approval rule, the handoff rule for logins and payment, and one short section per task row: what to do, what counts as proof, and the usual traps. For example, a cancellation flow that offers a discount instead of cancelling, or a booking that holds a slot without confirming it.
- `workerMcpServers`: `chrome-devtools-mcp` (user's Chrome), plus the mail and calendar connectors the user has enabled.
- `readEvidence`: reads the card's report for a `Confirmation:` block: the sender, subject, date and message id of the confirmation, or the calendar event id. In v1 it does not read the inbox itself, since the daemon holds no mail tokens. The done check, run by a worker with the mail connector, confirms the message exists.
- `checks`:
  - `life-admin.confirmed`: met when the evidence has a confirmation from the right sender after the card started.
  - `life-admin.approved`: met when the user ticked the decision item.

Recurring work (weekly inbox triage, a fare watch) uses core's reminders and follow-ups: one ask with a schedule, not a new mechanism.

## What v1 leaves out

- **Commissions and affiliate links.** Instinct earns on bookings. It's a business model choice, not a pack feature. Revisit once bookings work.
- **Agent to agent.** Restaurants or hotels running their own agents, or two users' agents agreeing a meeting time. Useful later. v1 talks to websites and email like a person does.
- **Reading bank statements.** "No charge after cancelling" needs a statement read. That waits for an evidence source the user connects, through MCP.
- **Phone calls.** Some bookings and cancellations need a call. Out of scope until there's a voice channel.

## Rollout

1. ADR 0009 rung e changes from legal review to this pack. The enable setting and the file-pack loader stay in e.
2. Ship the pack disabled. Dogfood it on our own life admin with option 1, the user's Chrome.
3. Turn it on by default once three task rows (orders, bookings, cancellations) have closed on a real confirmation each.

## Open questions

1. v1 attaches to the user's everyday Chrome. Is a separate window enough, or should v1 use a dedicated Chrome profile the user signs into once?
2. Which mail and calendar connectors are first: Gmail and Google Calendar only, or also Outlook and iCloud?
3. Should "watching" be its own small pack, since it's mostly scheduling and alerting, not acting?
