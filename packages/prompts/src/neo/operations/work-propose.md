---
id: NEO_WORK_PROPOSE_DESCRIPTION
---
Propose work from the current live input. For a card whose only job is a read-only check, use
work {verb:"read", operation, input}: the daemon runs that registered read operation immediately
without human approval, returns its result on the card, and never sends instruction to a worker.
This does not approve the ask or any other work. All other execution proposals need ordinary
approval. Every proposal must choose where it runs. targetSessionId names an exact ordinary
project/non-project chat, or an existing active long-horizon Space agent with matching
targetAgent {spaceId,agentId,sessionId} from daemon.snapshot; there is no standalone scratch
session. Instead of targetSessionId, work may name a drivers target: {verb:"start", adapter,
place, model?, effort?} to start new work in a place from work.find (set model and effort when
the human requests them; work.start validates the settings, with catalog model resolution for
Codex and effort currently supported only for local Codex starts) (for a new project folder that
does not exist yet, use place {machine, daemon?, folder, name} and add createFolder:true; the
folder must be under the home folder with an existing parent; never ask another session to
create a folder), or {verb:"send", ref} to continue work it found, or {verb:"adopt", ref} to
follow a session the human named in chat, without sending it anything (that
card starts on its own); starting the proposal then runs work.start or work.send as Neo. Managed
targets keep native tools and permissions. A targetSessionId that belongs to exactly one Space
task or agent is proposed as work {verb:"send"} to that task or agent; other owned and Neo-bound
sessions are refused with the route to use. Instructions alone do not bind a target. The target
is immutable for this card. When no target clearly fits, ask the human instead of
proposing. Set goal to what the human asked, in their own words, and doneWhen to a short
checklist of what finished means; both are sent to the worker with the instruction, so a shorter
instruction never drops the real goal. Open asks with the outcome checks required by their pack
before proposing work under their askId; unchecked doneWhen cannot create an ask requiring those
checks. Under an ask with open items, pass delivers with the ids of the items this card delivers (the daemon binds them to the card, and a card's items are met only once it reports), or delivers: [] for a card that delivers none, such as a read or a check. A retry of the same proposal in this turn returns the same card and keeps its stored ask. When this work replaces a failed or
cancelled card, pass supersedes with the id of that card so it shows as replaced; when the
project has failed or cancelled work from the last three days, the proposal is refused until you
pass supersedes, using null when it replaces none. A proposal to a session that already holds
live cards is refused with its load and the idle sessions in the same place; split independent
items across idle sessions, and pass allowBusyTarget:true only to queue behind the work of that
session on purpose. Only read and adopt targets run during proposal.
