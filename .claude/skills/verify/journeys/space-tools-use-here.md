# Use saved tool choices from the Space task panel (Tools 7b)

Use shared guarded setup in SKILL.md. Build web, then start the metadata-only
activation helper in a fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/session-tool-activation.ts --show-task-panel
```

This helper owns the isolated daemon, synthetic Space/task, scripted SDK and
in-memory MCP server. Task dispatch is stopped before seeding the task's worker
binding. The PANEL URL is the actual Space task page; no provider or external
server executable is used. Open that URL in an attended browser. Select Coder
as the message recipient if needed, then More options → Tools. A standalone
component preview or the ordinary session Tools modal is not proof here.

- Coder Tools must show one Browser Use here button although its defaults are
  off. Its saved choice and observed attachment remain separate.
- Enable Browser. The action must target the worker bound to this task, show
  Saved · applied to the running session, and observe Attached · 1 tool with
  the frozen alias and navigate name. Stop using here must remove that tool.
- Enable Guide. It must stay saved on and disclose restart required, without
  interrupting the worker or claiming instructions are already loaded.
- Close/reopen Tools and reload the task page. Guide's saved choice must survive;
  Browser remains off. The helper must retain exactly one worker query and zero
  worker interrupts. Model-list probe interrupts are counted separately.
- Check desktop and narrow layout, with the navigation drawer closed. Filter
  and clear the catalog, expand observed names, and retain the panel text and
  screenshots. Wait for the modal's opacity to reach one before screenshotting.

The helper seeds no separate Space agent, so the existing task page can say no
agent has worked yet. The recipient is resolved through durable post-approval
session provenance; verify the modal title and worker targeting in the recorded
fixture. Do not dispatch a task merely to change that unrelated page label.

Close the temporary browser tab and send SIGUSR1 only to the helper PID printed
with PANEL. SIGTERM also starts the daemon's shutdown and is not the proof's
finish signal. The JSON must contain pass, panelVerified, panelSurface=space-task,
resourcesStopped, the task fixture, Guide saved on, enable/removal applications,
workerQueryCount=1 and interrupts=0. The wrapper preserves evidence and deletes
owned temporary HOME/data/TMPDIR after cleanup.

Use --show-task-panel-before with the baseline web build to reproduce the
read-only panel with no Use here control. The first failing component regression
is committed before the wiring. Focused component checks additionally prove
that stale worker replies cannot replace the current selection, failed choice
loads do not erase observed inventory, inventory errors cannot leave attachment
claims in the picker, and closed panels perform no requests. The shared picker
suite covers refusal, retry, pending clicks and each application disclosure.
Real ACP transport, provider execution, browser navigation tools, Space/catalog
new-session default labels and obsolete setter removal remain separate scopes.
