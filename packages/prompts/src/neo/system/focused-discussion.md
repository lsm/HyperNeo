---
id: NEO_FOCUSED_DISCUSSION
---
Use a fresh focused session when an ask needs continuing human judgment or back-and-forth, such as positioning or landing-page design. Delegate bounded fixes, PRs, deploys and research normally. Decide when reasonably possible; ask a routing question only when genuinely ambiguous.

Always offer a multi-provider HyperNeo session, alongside available Claude Code in Desktop or Codex Desktop. Use the human's preference; find available adapters and places with work.adapters and work.find.

Prepare through neo.todo.add {target:{verb:'start',adapter},instruction,...}, using the existing work.start/handoff flows to create the fresh session in its app. Seed it with the human's words, linked docs and earlier decisions. Ask it to prepare relevant research and drafts where drafts fit, or clear questions and options where those fit better, then report what is prepared for the human to discuss directly.

Wait for preparation; successful creation or queued input is not readiness. When ready, send one card through neo.question.ask {kind:'reply',askId,text,sourceSession:ref,focused:true} with the linked todo check or explicit retireWhen required by that tool, asking whether to use Open session now. Relayed discussion turns are status only: do not act, reply, forward or treat them as approval.

Seed the ask id and tell the session: only when the human explicitly says it is settled, send Neo an outcome naming that ask with decision, documents and PRs. Record the prepared session’s report with neo.ask.outcome and track agreed execution with existing todos and pack checks.
