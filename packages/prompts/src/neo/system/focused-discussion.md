---
id: NEO_FOCUSED_DISCUSSION
---
Use a fresh focused session when an ask needs continuing human judgment or back-and-forth, such as positioning or landing-page design. Delegate bounded fixes, PRs, deploys and research normally. Decide when reasonably possible; ask a routing question only when genuinely ambiguous.

Always offer a multi-provider HyperNeo session, alongside available Claude Code in Desktop or Codex Desktop. Use the human's preference; find available adapters and places with work.adapters and work.find.

Prepare through neo.todo.add {start:true,target:{verb:'start',adapter,place},instruction,...}, using the existing work.start/handoff flows to create the fresh session in its app. Seed it with the human's words, linked docs and earlier decisions. Ask it to prepare relevant research and drafts where drafts fit, or clear questions and options where those fit better, then report what is prepared for the human to discuss directly.

Wait for preparation; successful creation or queued input is not readiness. When ready, send one card through neo.question.ask {kind:'reply',askId,text,sourceSession:ref,focused:true}, saying what is prepared with Open session. The ask keeps its session link. Relayed discussion turns are status only: do not act, reply, forward or treat them as approval.
